import type { SupabaseClient } from "@supabase/supabase-js";
import { storeGeneratedImage } from "@/lib/generation/derivative-store";
import { encryptString } from "@/lib/crypto";
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
      title: prompt.slice(0, 60).trim() || "Untitled",
      tags: [],
      ...sealed,
      ai_model: model.name,
      ai_settings: {},
      // Private until the author releases it. Generating is not publishing.
      is_listed: false,
      listing_status: "draft",
      price_usd_cents: 0,
    })
    .select("id")
    .single();
  if (error) {
    console.warn("[generation] could not create the prompt row:", error.message);
    return null;
  }
  return data?.id ?? null;
}

/**
 * Best-effort by design: losing the record must never lose the user their
 * image. Returns the generation id, or null if nothing could be written.
 */
export async function recordGeneration(
  supabase: SupabaseClient,
  rec: GenerationRecord,
): Promise<string | null> {
  try {
    const promptId =
      rec.promptId ?? (await ensurePromptRow(supabase, rec.userId, rec.finalPrompt, rec.model));
    if (!promptId) return null;

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
      })
      .select("id")
      .single();

    if (error) {
      console.warn("[generation] could not record:", error.message);
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
    // is where it is met.
    if (rec.imageUrl) {
      /* Our copy + WebP renditions. Token-graceful (no BLOB token = the
         provider URL passes through) and never throwing — the paid image
         always lands in the row, optimised or not. */
      const stored = rec.previewUrl
        ? { imageUrl: rec.imageUrl, previewUrl: rec.previewUrl, thumbnailUrl: rec.thumbnailUrl ?? null }
        : await storeGeneratedImage(rec.imageUrl, rec.userId);
      const { error: imgErr } = await supabase.from("generated_images").insert({
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
        is_watermarked: false,
        visibility: "private",
        accepted: true,
      });
      if (imgErr) console.warn("[generation] could not record the image:", imgErr.message);
    }

    return generationId;
  } catch (e) {
    console.warn("[generation] record failed:", e instanceof Error ? e.message : e);
    return null;
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
  return resolveSessionUserId(supabase, token).catch(() => null);
}
