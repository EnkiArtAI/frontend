/**
 * What follows a caught extraction attempt: nothing the buyer can see.
 *
 * Kev, 2026-10-02: record it quietly until it is certain the attempts are on
 * purpose, then block, without the buyer getting wind of it. A buyer warned
 * at the first catch only gets more careful. So the buyer gets the same
 * failure as any other, and every hit lands in the moderation review queue
 * (automod_events, category "extraction", the values encrypted) with a mail
 * to the team. The third hit within 30 days bans the account in the name of
 * the moderation owner, as the existing auto-ban does, appealable through
 * /banned. Agents have no account: their hits count by hashed IP, and the
 * third one stops paid-prompt generations from that address.
 */
import { createHash } from "crypto";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptString } from "@/lib/crypto";
import { getClientIp, hashIp } from "@/lib/ip-hash";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { banUntil } from "@/lib/moderation/bans";
import { notifyAdmins } from "@/lib/admin-notify";

export const EXTRACTION_HITS_TO_BLOCK = 3;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type Req = { headers: { get(name: string): string | null } };

/** The same answer as any failed generation: no hint that a check exists, let alone what it caught. */
export const SILENT_FAILURE = { error: "Image generation failed. Nothing was charged.", retryable: true } as const;

export const SILENT_DELAY_MS = { min: 3000, max: 12000 } as const;

/**
 * The silent answer, after a pause in the range a real generation takes to
 * fail: an instant failure would tell a buyer that something judged the
 * request before any generator ran. Every real generation failure answers
 * with the same SILENT_FAILURE body, so neither text nor timing differs.
 */
export async function silentFailure(): Promise<NextResponse> {
  await new Promise((done) => setTimeout(done, SILENT_DELAY_MS.min + Math.random() * (SILENT_DELAY_MS.max - SILENT_DELAY_MS.min)));
  return NextResponse.json(SILENT_FAILURE, { status: 500 });
}

async function hitsSince(supabase: SupabaseClient, who: { userId: string | null; ipHash: string | null }): Promise<number> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  let q = supabase.from("automod_events").select("id", { count: "exact", head: true }).eq("category", "extraction").gte("created_at", since);
  if (who.userId) q = q.eq("user_id", who.userId);
  else if (who.ipHash) q = q.is("user_id", null).eq("ip_hash", who.ipHash);
  else return 0;
  const { count } = await q;
  return count ?? 0;
}

/** An agent address that reached the threshold. Accounts are stopped by their ban instead. */
export async function agentBlocked(supabase: SupabaseClient, request: Req): Promise<boolean> {
  const ipHash = hashIp(getClientIp(request));
  return ipHash !== null && (await hitsSince(supabase, { userId: null, ipHash })) >= EXTRACTION_HITS_TO_BLOCK;
}

/** Fire-and-forget from after(): a failure here must never change what the buyer saw. */
export async function recordExtractionHit(
  supabase: SupabaseClient,
  ctx: { surface: string; request: Req; values: Record<string, string>; confidence: number },
): Promise<void> {
  try {
    const token = ctx.request.headers.get("X-Session-Token");
    // The account even while it is suspended (see recordWarning).
    const userId = token ? await resolveSessionUserWithBan(supabase, token).then((s) => s.userId).catch(() => null) : null;
    const ipHash = hashIp(getClientIp(ctx.request));
    const sorted = JSON.stringify(Object.fromEntries(Object.entries(ctx.values).sort(([a], [b]) => a.localeCompare(b))));
    let evidence: { encrypted: string; iv: string; authTag: string; kid?: string } | null = null;
    try {
      evidence = encryptString(sorted.slice(0, 4000));
    } catch {
      evidence = null; // never let a crypto config problem lose the event
    }

    const { data: event } = await supabase
      .from("automod_events")
      .insert({
        user_id: userId,
        ip_hash: ipHash,
        surface: ctx.surface,
        decision: "block",
        severity: "strike",
        tier: 2,
        category: "extraction",
        scores: { extraction: ctx.confidence },
        prompt_hash: createHash("sha256").update(sorted).digest("hex"),
        evidence_ct: evidence?.encrypted ?? null,
        evidence_iv: evidence?.iv ?? null,
        evidence_tag: evidence?.authTag ?? null,
        evidence_kid: evidence?.kid ?? null,
        review_state: "pending",
      })
      .select("id")
      .single();

    const hits = await hitsSince(supabase, { userId, ipHash });
    const who = userId ? `account ${userId}` : "an agent (hashed IP)";
    await notifyAdmins(supabase, {
      subject: `Extraction attempt ${hits}/${EXTRACTION_HITS_TO_BLOCK}: ${who}`,
      text:
        `A paid prompt's inputs from ${who} tried to get the hidden text shown (confidence ${ctx.confidence.toFixed(2)}, ${ctx.surface}). ` +
        `The buyer saw an ordinary failure and was not charged. The inputs are in the admin moderation queue. ` +
        (hits >= EXTRACTION_HITS_TO_BLOCK ? "This hit reached the threshold and blocks them." : "Nothing else happens until the threshold."),
    });

    if (userId && hits >= EXTRACTION_HITS_TO_BLOCK) await ban(supabase, userId, event?.id as string | undefined);
  } catch {
    /* recording is best-effort by design */
  }
}

async function ban(supabase: SupabaseClient, userId: string, eventId: string | undefined): Promise<void> {
  // bans.issued_by is NOT NULL: issued in the name of the moderation owner,
  // who answers for it and can lift it, like the existing auto-ban.
  const { data: policy } = await supabase.from("moderation_policy").select("owner_user_id").eq("id", 1).maybeSingle();
  const issuedBy = policy?.owner_user_id as string | undefined;
  if (!issuedBy) return; // no owner configured: the team decides from the queue

  // For good, as its own row beside any running ban (lib/moderation/bans.ts). The
  // reason is shown to the user on /banned, so it names nothing that would
  // tell them which of their requests were caught; the events linked through
  // ban_id say what happened.
  const issued = await banUntil(supabase, {
    userId, issuedBy, reason: "Automated: repeated violations of the Terms of Service", expiresAt: null,
  });
  if (issued?.issued && issued.id && eventId) await supabase.from("automod_events").update({ ban_id: issued.id }).eq("id", eventId);
}
