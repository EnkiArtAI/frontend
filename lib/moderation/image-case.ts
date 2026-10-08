import { createHash, randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptString, decryptString, type EncryptedPayload } from "@/lib/crypto";
import { sealEvidence } from "@/lib/moderation/evidence";
import { getClientIp, hashIp } from "@/lib/ip-hash";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { notifyAdmins } from "@/lib/admin-notify";

/**
 * A suspected child-safety image (the image check's child_safety verdict).
 * It is never shown; a copy is kept privately as evidence; a human decides
 * (Kev, 2026-10-08: no automatic sanction, and the check's minor estimate is
 * noisy). So neither recordWarning (child safety weighs 10 and suspends at
 * once) nor recordModerationEvent (maybeAutoBan bans at sexual/minors 0.9):
 * one pending 'csam' event, which the admin panel already flags as child
 * safety and only an admin may close, plus a mail to the admins.
 */
export const EVIDENCE_BUCKET = "moderation-evidence";
/** Each copy is sealed to its own record: a file moved to another record does not open. */
const aad = (eventId: string) => `image-evidence/${eventId}`;
const path = (eventId: string) => `${eventId}.json`;

type Req = { headers: { get(name: string): string | null } };

export async function recordImageCase(
  supabase: SupabaseClient,
  ctx: {
    surface: string;
    request: Req;
    bytes: Buffer;
    scores?: Record<string, number>;
    /** What a moderator may read about the request: never an artist's words. */
    about: string;
    promptId?: string;
    /** On the agent rail an account's session counts for nothing: the record goes by address. */
    byAddress?: boolean;
  },
): Promise<void> {
  try {
    const eventId = randomUUID();
    // The evidence first, encrypted, in a bucket only the server reads. The
    // record goes in even when the copy could not be kept, and says so.
    let kept = false;
    try {
      await supabase.storage.createBucket(EVIDENCE_BUCKET, { public: false }).catch(() => {});
      // Never where anyone could fetch it, sealed or not: a bucket made
      // public by hand keeps nothing.
      const { data: bucket } = await supabase.storage.getBucket(EVIDENCE_BUCKET);
      if (bucket?.public !== false) throw new Error("the evidence bucket is not private");
      const sealed = encryptString(ctx.bytes.toString("base64"), aad(eventId));
      const { error } = await supabase.storage.from(EVIDENCE_BUCKET)
        .upload(path(eventId), Buffer.from(JSON.stringify(sealed)), { contentType: "application/json", upsert: false });
      kept = !error;
      if (error) console.error("[image-case] evidence copy not kept:", error.message);
    } catch (e) {
      console.error("[image-case] evidence copy not kept:", e instanceof Error ? e.message : e);
    }

    const token = ctx.byAddress ? null : ctx.request.headers.get("X-Session-Token");
    // The account even while it is suspended (see recordWarning).
    const userId = token ? await resolveSessionUserWithBan(supabase, token).then((s) => s.userId).catch(() => null) : null;
    const evidence = sealEvidence({ shown: ctx.about, promptId: ctx.promptId });
    const { error } = await supabase.from("automod_events").insert({
      id: eventId,
      user_id: userId,
      ip_hash: hashIp(getClientIp(ctx.request)),
      surface: ctx.surface,
      decision: "block",
      severity: "review",
      tier: 2,
      category: "csam",
      matched_rules: ["image-check"],
      scores: ctx.scores ?? {},
      prompt_hash: createHash("sha256").update(ctx.bytes).digest("hex"),
      evidence_ct: evidence?.encrypted ?? null,
      evidence_iv: evidence?.iv ?? null,
      evidence_tag: evidence?.authTag ?? null,
      evidence_kid: evidence?.kid ?? null,
      review_state: "pending",
    });
    if (error) console.error("[image-case] case not recorded:", error.message);

    const who = userId ? `account ${userId}` : ctx.byAddress ? "an agent (hashed IP)" : "a visitor (hashed IP)";
    // No link and no image: the mail also reaches mods, and mail is no place for it.
    await notifyAdmins(supabase, {
      subject: `Child-safety image held for review: ${who}`,
      text: [
        `The image check judged an image on ${ctx.surface} from ${who} as possible child sexual content.`,
        "It was not delivered or published, and no sanction was applied: an admin decides.",
        kept ? "A private, encrypted copy is kept with the case for the moderation owner's logged reveal." : "The private copy could NOT be kept.",
        error
          ? `The case could NOT be recorded (see the server log), so it is not in the admin People list.${kept ? ` Its copy is ${EVIDENCE_BUCKET}/${path(eventId)}.` : ""}`
          : `Case ${eventId} waits in the admin People list, flagged child safety.`,
      ].join("\n"),
    });
  } catch {
    /* recording is best-effort: the refusal itself has already happened */
  }
}

/** The kept copy as a data: URL for the owner's logged reveal, or null when there is none. */
export async function readImageEvidence(supabase: SupabaseClient, eventId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).download(path(eventId));
    if (error || !data) return null;
    const bytes = Buffer.from(decryptString(JSON.parse(await data.text()) as EncryptedPayload, aad(eventId)), "base64");
    return `data:${mediaType(bytes)};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** By the first bytes: the copy is whatever the route held, a still the check judges (PNG, JPEG, WebP or GIF). */
function mediaType(b: Buffer): string {
  if (b.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (b.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  return "application/octet-stream";
}
