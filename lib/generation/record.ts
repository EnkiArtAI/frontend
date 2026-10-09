import type { SupabaseClient } from "@supabase/supabase-js";
import { storeGeneratedImage } from "@/lib/generation/derivative-store";
import { encryptString } from "@/lib/crypto";
import { isDbUnreachable } from "@/lib/db-error";
import type { ResolvedModel, Route } from "@/lib/generation/models";
import type { StoredReference } from "@/lib/generation/reference-images";

/**
 * Write down what produced an image, in enough detail to run it again.
 *
 * Nothing recorded a generation before this. `POST /api/generations` inserted
 * columns that do not exist (final_prompt, status, image_urls, payment_verified)
 * and its six callers wrapped the failure in `catch { /* ignore *\/ }`, so the
 * table stayed empty and every generation vanished the moment the tab closed.
 *
 * ── The two honest limits ───────────────────────────────────────────────
 * A faithful record is not byte-identical replay, and the gap is stated rather
 * than papered over:
 *
 *   1. No provider we use exposes a seed except Pollinations, which generates
 *      one and discards it. `seed` is NULL for Gemini and WaveSpeed, and NULL
 *      here means "not reproducible", not "not recorded".
 *   2. effectivePrompt (the text that actually reached the model) is stored
 *      separately from what the user typed, and it is what a replay must send.
 *
 * So the button this feeds should say "Re-run", not "Reproduce".
 */

export interface GenerationRecord {
  userId: string;
  /** The marketplace prompt used, or null for a free-form editor generation. */
  promptId: string | null;
  /** After variable substitution, before the rewrite. */
  finalPrompt: string;
  /** What actually reached the image model. */
  effectivePrompt: string;
  variableValues: unknown;
  model: ResolvedModel;
  /** 18+: from the prompt check or the prompt's own mark. Shown to other people only when they opted in. */
  adult?: boolean;
  route: Route;
  boost: boolean;
  aspectRatio: string | null;
  resolution: string | null;
  seed: number | null;
  /** Measured from the returned bytes — never echoed from the request. */
  output: { width: number; height: number; bytes: number; format: string } | null;
  /**
   * Where the image ended up. Written into generated_images, which is what the
   * gallery reads — without it a paid image exists in blob storage and in
   * generations, and the user can never find it again.
   */
  imageUrl?: string | null;
  previewUrl?: string | null;
  thumbnailUrl?: string | null;
  mimeType?: string | null;
  generationMs: number | null;
  /** The editor node graph — structure only, no image bytes and no text. */
  workflow: Record<string, unknown> | null;
  /**
   * The strings pulled out of that graph. Encrypted here, never stored in the
   * jsonb: the prompt would otherwise sit in clear two columns from
   * final_prompt_ct and make that encryption decoration.
   */
  workflowTexts?: string[];
  /**
   * The images fed in, in prompt order. A null keeps the position — "@Image 2"
   * has to keep meaning the second one even if the second failed to store.
   */
  references?: (StoredReference | null)[];
  transactionHash?: string | null;
  chainKey?: string | null;
  amountPaidCents?: number | null;
  /** The generation_payment_intents row this was bought with; null for free generations. */
  paymentIntentId?: string | null;
}

/**
 * What recordGeneration hands back: the generations row always (when
 * anything was written at all), the generated_images row's id only when that
 * second insert also landed. A route that needs to answer with "imageId"
 * reads this, not the bare string the old contract returned — checked
 * against every caller (generate-image, generate-free) before this changed:
 * both call recordGeneration from inside a floating/after() promise and read
 * nothing back, so widening the return shape breaks neither.
 */
export interface RecordedGeneration {
  generationId: string;
  imageId: string | null;
}

/** Encrypt into the four columns this schema uses everywhere. */
function envelope(prefix: string, plaintext: string): Record<string, string> {
  const p = encryptString(plaintext);
  return {
    [`${prefix}_ct`]: p.encrypted,
    [`${prefix}_iv`]: p.iv,
    [`${prefix}_tag`]: p.authTag,
    [`${prefix}_kid`]: p.kid ?? "field-v1",
  };
}

/**
 * A free-form generation still needs a prompt row, because generations.prompt_id
 * is NOT NULL — and that constraint is right: it is what keeps every image
 * traceable to an author, which is what artist payouts rest on.
 *
 * The user wrote the prompt, so they get a prompt row of their own, private.
 * Publishing later is then a visibility change on something that already
 * exists, rather than a second code path that has to reconstruct it.
 */
async function ensurePromptRow(
  supabase: SupabaseClient,
  userId: string,
  prompt: string,
  model: ResolvedModel,
  adult = false,
): Promise<string | null> {
  // The prompts table predates the `_ct` convention: its ciphertext column is
  // plain `encrypted_content`, while iv/tag/kid carry the prefix. Probed live
  // 2026-08-08 — encrypted_content_ct is 400, encrypted_content is 200. The
  // envelope spread wrote the former, so every free-form generation's prompt
  // row failed with PGRST204 and recordGeneration bailed before writing
  // anything at all.
  const sealed = envelope("encrypted_content", prompt);
  sealed.encrypted_content = sealed.encrypted_content_ct;
  delete sealed.encrypted_content_ct;

  const { data, error } = await supabase
    .from("prompts")
    .insert({
      creator_id: userId,
      // Never derived from the prompt: the body is encrypted at rest, and a
      // title made of its first words would carry them in the clear.
      title: "Untitled",
      tags: [],
      ...sealed,
      ai_model: model.name,
      ai_settings: {},
      // Private until the author releases it. Generating is not publishing.
      is_listed: false,
      listing_status: "draft",
      price_usd_cents: 0,
      is_adult: adult,
    })
    .select("id")
    .single();
  if (error) {
    console.warn("[generation] could not create the prompt row:", error.message);
    return null;
  }
  return data?.id ?? null;
}

/** Whether this record carries real money — gates the admin alert below. */
function isPaid(rec: GenerationRecord): boolean {
  return rec.paymentIntentId != null || rec.amountPaidCents != null;
}

/**
 * Losing a free generation's record is a shrug — console.warn and move on,
 * as this always has. Losing a PAID one is a different severity: the buyer
 * was charged, the image was handed over, and now nothing says so. The image
 * is never withheld for it (that is decided before this is ever called), but
 * someone has to go reconcile the row by hand, and a warning only this
 * process ever sees is not how they find out.
 */
async function alertLostRecording(supabase: SupabaseClient, rec: GenerationRecord, reason: string): Promise<void> {
  console.error("[generation] PAID generation recording problem:", {
    userId: rec.userId,
    paymentIntentId: rec.paymentIntentId ?? null,
    reason,
  });
  const { notifyAdmins } = await import("@/lib/admin-notify");
  await notifyAdmins(supabase, {
    subject: "Paid generation not recorded",
    text:
      `A paid generation for user ${rec.userId} (payment intent ${rec.paymentIntentId ?? "unknown"}) ` +
      `was delivered to the buyer, but ${reason}. The image was NOT lost — it was already returned ` +
      `to the payer — but its generations/generated_images row is missing or incomplete and needs a ` +
      `manual look.`,
  }).catch((e) => console.error("[generation] admin alert failed:", e instanceof Error ? e.message : e));
}

/**
 * Best-effort by design: losing the record must never lose the user their
 * image. Returns the generations row id and, when that second insert also
 * landed, the generated_images row id a caller can answer with as imageId —
 * null when nothing could be written at all.
 */
export async function recordGeneration(
  supabase: SupabaseClient,
  rec: GenerationRecord,
): Promise<RecordedGeneration | null> {
  try {
    const promptId =
      rec.promptId ?? (await ensurePromptRow(supabase, rec.userId, rec.finalPrompt, rec.model, rec.adult === true));
    if (!promptId) {
      if (isPaid(rec)) await alertLostRecording(supabase, rec, "no prompt row could be created for it");
      return null;
    }

    const { data, error } = await supabase
      .from("generations")
      .insert({
        user_id: rec.userId,
        prompt_id: promptId,
        ...envelope("final_prompt", rec.finalPrompt),
        ...envelope("effective_prompt", rec.effectivePrompt),
        ...envelope("variable_values", JSON.stringify(rec.variableValues ?? {})),
        model_id: rec.model.id,
        provider: rec.route.provider,
        provider_model: rec.route.providerModel,
        boost: rec.boost,
        aspect_ratio: rec.aspectRatio,
        resolution: rec.resolution,
        seed: rec.seed,
        output_width: rec.output?.width ?? null,
        output_height: rec.output?.height ?? null,
        output_bytes: rec.output?.bytes ?? null,
        output_format: rec.output?.format ?? null,
        generation_ms: rec.generationMs,
        workflow: rec.workflow,
        ...(rec.workflowTexts?.length
          ? envelope("workflow_text", JSON.stringify(rec.workflowTexts))
          : {}),
        transaction_hash: rec.transactionHash ?? null,
        chain_key: rec.chainKey ?? null,
        amount_paid_cents: rec.amountPaidCents ?? null,
        payment_intent_id: rec.paymentIntentId ?? null,
      })
      .select("id")
      .single();

    if (error) {
      console.warn("[generation] could not record:", error.message);
      if (isPaid(rec)) await alertLostRecording(supabase, rec, "the generations insert failed");
      return null;
    }
    const generationId = data.id as string;

    // The inputs, in prompt order — "@Image 2" refers to sequence_index 1, so
    // the index comes from the ORIGINAL position and never from a filtered
    // array. A reference that failed to store simply has no row.
    const rows = (rec.references ?? [])
      .map((ref, i) => (ref ? { ...ref, sequence_index: i } : null))
      .filter((r): r is StoredReference & { sequence_index: number } => r !== null);

    if (rows.length) {
      const { error: refErr } = await supabase.from("generation_reference_images").insert(
        rows.map((r) => ({
          generation_id: generationId,
          sequence_index: r.sequence_index,
          storage_url: r.url,
          mime_type: r.mimeType,
          bytes: r.bytes,
          content_hash: r.contentHash,
        })),
      );
      if (refErr) console.warn("[generation] could not record references:", refErr.message);
    }

    // The image itself. generations records what PRODUCED it; generated_images
    // is what the gallery reads, and nothing was ever writing a row there for a
    // generation — so a delivered image was invisible to its owner. "Ordered
    // means delivered" (Kev, 2026-08-06) is a durability requirement, and this
    // is where it is met. Its id is also what a caller answers "imageId" with
    // (REC-1) — selected back below, never derived from anything else.
    let imageId: string | null = null;
    if (rec.imageUrl) {
      /* Our copy + WebP renditions. Token-graceful (no BLOB token = the
         provider URL passes through) and never throwing — the paid image
         always lands in the row, optimised or not. A caller that passes
         previewUrl, even null, stored the image itself: storing it again
         here would be unbounded work in after(). */
      const stored = rec.previewUrl !== undefined
        ? { imageUrl: rec.imageUrl, previewUrl: rec.previewUrl, thumbnailUrl: rec.thumbnailUrl ?? null }
        : await storeGeneratedImage(rec.imageUrl, rec.userId);
      const { data: imgRow, error: imgErr } = await supabase
        .from("generated_images")
        .insert({
          user_id: rec.userId,
          generation_id: generationId,
          prompt_id: promptId,
          sequence_index: 0,
          storage_provider: "vercel_blob",
          storage_url: stored.imageUrl,
          preview_url: stored.previewUrl,
          thumbnail_url: stored.thumbnailUrl,
          width: rec.output?.width ?? null,
          height: rec.output?.height ?? null,
          file_size_bytes: rec.output?.bytes ?? null,
          mime_type: rec.mimeType ?? (rec.output?.format ? `image/${rec.output.format}` : "image/png"),
          // Generated, not uploaded — the flag the gallery filters on, and the
          // one chk_upload_consistency checks against generation_id.
          is_uploaded: false,
          is_adult: rec.adult === true,
          is_watermarked: false,
          visibility: "private",
          accepted: true,
        })
        .select("id")
        .single();
      if (imgErr) {
        // The generations row above is real and stays: the caller still gets
        // a generationId. What it loses is imageId — the gallery/share-preview
        // row simply does not exist for this one.
        console.warn("[generation] could not record the image:", imgErr.message);
        if (isPaid(rec)) await alertLostRecording(supabase, rec, "the generated_images insert failed (the generation row was written; the gallery row was not)");
      } else {
        imageId = (imgRow?.id as string | undefined) ?? null;
      }
    }

    return { generationId, imageId };
  } catch (e) {
    console.warn("[generation] record failed:", e instanceof Error ? e.message : e);
    if (isPaid(rec)) await alertLostRecording(supabase, rec, "recording threw an exception").catch(() => {});
    return null;
  }
}

/**
 * The WebP preview/thumbnail a core write deliberately left for later
 * (REC-1): the generations/generated_images rows are written before the
 * response so it can carry imageId, and deriving the renditions is not worth
 * making a buyer who already paid wait for — it runs from `after()` instead.
 *
 * `storeGeneratedImage` already skips re-uploading the original when it
 * recognises the URL as already one of our own stores, so this costs two
 * small WebP uploads, not a second copy of the original.
 *
 * Best-effort, like everything else here: a failed derivative pass leaves
 * the row exactly as the core write left it (preview/thumbnail null, the
 * original URL doing both jobs) and never throws into its caller's after().
 */
export async function attachImageDerivatives(
  supabase: SupabaseClient,
  imageId: string,
  imageUrl: string,
  userId: string,
  deadline?: number,
): Promise<void> {
  try {
    const derived = await storeGeneratedImage(imageUrl, userId, deadline);
    if (!derived.previewUrl && !derived.thumbnailUrl) return;
    const { error } = await supabase
      .from("generated_images")
      .update({ preview_url: derived.previewUrl, thumbnail_url: derived.thumbnailUrl })
      .eq("id", imageId);
    if (error) console.warn("[generation] could not attach derivatives:", error.message);
  } catch (e) {
    console.warn("[generation] derivative pass failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * The reference images fed INTO a generation — stored and linked after the
 * response, same reasoning as attachImageDerivatives: storeReferenceImages
 * does one upload per reference with no deadline of its own, so it must not
 * sit between a captured payment and the answer either. Mirrors
 * recordGeneration's own reference-row insert (sequence_index from the
 * ORIGINAL position, a failed-to-store reference simply has no row) —
 * duplicated rather than shared, because recordGeneration's version runs
 * inside its own transaction-shaped try/catch and this one runs standalone,
 * from after(), on a generation that has already been written.
 */
export async function attachReferenceImages(
  supabase: SupabaseClient,
  generationId: string,
  images: (StoredReference | null)[],
): Promise<void> {
  try {
    const rows = images
      .map((ref, i) => (ref ? { ...ref, sequence_index: i } : null))
      .filter((r): r is StoredReference & { sequence_index: number } => r !== null);
    if (!rows.length) return;
    const { error } = await supabase.from("generation_reference_images").insert(
      rows.map((r) => ({
        generation_id: generationId,
        sequence_index: r.sequence_index,
        storage_url: r.url,
        mime_type: r.mimeType,
        bytes: r.bytes,
        content_hash: r.contentHash,
      })),
    );
    if (error) console.warn("[generation] could not record references:", error.message);
  } catch (e) {
    console.warn("[generation] reference attach failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Whose generation this is, resolved server-side.
 *
 * From the session token, never from a body field: PR #54 keyed enforcement on
 * a client-supplied wallet, which let anyone write rows under someone else's
 * name. A generation with no session is simply not recorded — an unattributed
 * row would be worse than none, because it cannot be shown back to anyone.
 */
export async function resolveRecordingUserId(
  supabase: SupabaseClient | null,
  request: { headers: { get(name: string): string | null } },
): Promise<string | null> {
  if (!supabase) return null;
  const token = request.headers.get("X-Session-Token");
  if (!token) return null;
  const { resolveSessionUserId } = await import("@/lib/session-user");
  // An unreachable database reaches the caller (503), it is not "nobody".
  return resolveSessionUserId(supabase, token).catch((e) => {
    if (isDbUnreachable(e)) throw e;
    return null;
  });
}

/**
 * The Enki account a wallet address is linked to, or null when it is not
 * linked to one at all — the ordinary case for an x402 agent wallet, which
 * pays through the protocol with no Enki account behind it.
 *
 * Same lookup already inlined in lib/session-user.ts and
 * app/api/auth/wallet/jwt/route.ts (user_wallets.address, removed_at null);
 * exact match, not case-insensitive — a Solana base58 address is
 * case-sensitive, unlike the EVM-style hex addresses the other two callers
 * also happen to handle.
 *
 * recordGeneration's user_id is a NOT NULL FK to users.id (verified live;
 * see REC-1/ENG-07). There is no "record under the bare wallet" option
 * without either minting a users row for an address nobody signed up with,
 * or relaxing that constraint — both product/schema decisions, not this
 * helper's to make. It returns null and the caller does not record, rather
 * than guessing.
 */
export async function resolveUserIdForWallet(
  supabase: SupabaseClient | null,
  address: string,
): Promise<string | null> {
  if (!supabase || !address) return null;
  const { data, error } = await supabase
    .from("user_wallets")
    .select("user_id")
    .eq("address", address)
    .is("removed_at", null)
    .maybeSingle();
  if (error) {
    console.warn("[generation] wallet->user lookup failed:", error.message);
    return null;
  }
  return (data?.user_id as string | undefined) ?? null;
}

/** What a failed generation asked for, so an admin can see what broke for whom (Kev, 2026-10-03). */
export interface GenerationFailure {
  request: { headers: { get(name: string): string | null } };
  surface: "generate-image" | "generate-free" | "x402-generate";
  modelId: string | null;
  resolution: string | null;
  quality: string | null;
  boost: boolean;
  aspectRatio: string | null;
  referenceImageCount: number;
  /** The prompt as the user wrote it; for an artist's prompt only the buyer's values; null for an artist's draft. Stored encrypted. */
  prompt: string | null;
  error: string;
  imageUrl?: string | null;
  intentId?: string | null;
  txSignature?: string | null;
}

/**
 * The other half of recordGeneration: a generation that was accepted and then
 * broke. Called from after(), and a failure to record never changes what the
 * user saw.
 */
export async function recordGenerationFailure(supabase: SupabaseClient | null, f: GenerationFailure): Promise<void> {
  if (!supabase) return;
  try {
    const userId = await resolveRecordingUserId(supabase, f.request);
    const { getClientIp, hashIp } = await import("@/lib/ip-hash");
    const { error } = await supabase.from("generation_failures").insert({
      user_id: userId,
      ip_hash: hashIp(getClientIp(f.request)),
      surface: f.surface,
      model_id: f.modelId,
      resolution: f.resolution,
      quality: f.quality,
      boost: f.boost,
      aspect_ratio: f.aspectRatio,
      reference_image_count: f.referenceImageCount,
      error: f.error.slice(0, 1000),
      ...(f.prompt === null ? {} : envelope("prompt", f.prompt.slice(0, 4000))),
      image_url: f.imageUrl ?? null,
      intent_id: f.intentId ?? null,
      tx_signature: f.txSignature ?? null,
    });
    // Best effort, but never silent: a missing table or a bad value would
    // otherwise lose every row without a trace.
    if (error) console.warn("[generation-failures] not recorded:", error.message);
  } catch {
    /* recording is best-effort by design */
  }
}
