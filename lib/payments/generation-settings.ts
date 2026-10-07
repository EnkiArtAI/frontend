/**
 * The sum of a paid generation's settings, decided once.
 *
 * Kev, 2026-10-02: "erstell doch einfach summe an einstellungen, figure out
 * the price and then once it's all done, let intents do the rest". The quote
 * and the intent take the same settings, the server prices them, the intent
 * stores them, and /api/generate-image runs exactly what was stored. Before,
 * the intent kept only the family and the resolution while the generate
 * request chose quality and boost itself, so a gpt-image-2 intent paid at
 * "low" ($0.012) could render at "high" ($0.428).
 *
 * The model is named by its row id: the exact row the user selected, never a
 * family that more than one row could answer to.
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveModel, hasBoost } from "@/lib/generation/models";
import { toModelFamily } from "@/lib/generation/model-family";
import { RESOLUTION_TIERS, type ResolutionTier } from "@/lib/generation/resolution";
import { effectiveQuality, type GptQuality } from "@/lib/pricing";

export const settingsSchema = z.object({
  /* Absent when buyers generate from their own prompt (the editors). */
  promptId: z.string().min(1).max(128).optional(),
  modelId: z.string().uuid(),
  resolution: z.enum(["1K", "2K", "4K"]),
  boost: z.boolean().optional(),
  quality: z.enum(["low", "medium", "high"]).optional(),
  referenceImageCount: z.number().int().min(0).max(18).optional(),
});

export type SettingsInput = z.infer<typeof settingsSchema>;

export interface PaidSettings {
  modelId: string;
  modelFamily: string;
  resolution: ResolutionTier;
  /** The quality that runs and is priced; null for models without the lever. */
  quality: GptQuality | null;
  boost: boolean;
  referenceImageCount: number;
}

export type SettingsResult =
  | { ok: true; settings: PaidSettings }
  | { ok: false; status: 422; error: string };

const refuse = (error: string): SettingsResult => ({ ok: false, status: 422, error });

/** Resolve the selection to settings the server can price and run, or refuse. */
export async function resolvePaidSettings(
  supabase: SupabaseClient,
  input: SettingsInput,
): Promise<SettingsResult> {
  const model = await resolveModel(supabase, [input.modelId]);
  if (!model?.id) return refuse("The chosen model is unknown or not available right now.");
  if (model.normal.provider === "pollinations") return refuse(`${model.name} is free and takes no payment.`);

  if (RESOLUTION_TIERS.indexOf(input.resolution) > RESOLUTION_TIERS.indexOf(model.maxResolution)) {
    return refuse(`${model.name} renders up to ${model.maxResolution}.`);
  }
  const boost = input.boost === true;
  if (boost && !hasBoost(model)) return refuse(`${model.name} has no boost.`);
  const referenceImageCount = input.referenceImageCount ?? 0;
  if (referenceImageCount > model.maxRefs) {
    return refuse(`${model.name} takes at most ${model.maxRefs} reference images.`);
  }

  return {
    ok: true,
    settings: {
      modelId: model.id,
      modelFamily: toModelFamily(model.name),
      resolution: input.resolution,
      quality: model.supportsQuality ? effectiveQuality(input.resolution, input.quality) : null,
      boost,
      referenceImageCount,
    },
  };
}

/** What the intent row stored, as /api/generate-image reads it back. */
export interface StoredSettings {
  model_id: string | null;
  resolution: string;
  quality: string | null;
  boost: boolean;
  reference_image_count: number;
}

/**
 * The first setting a generate request repeats differently from what was
 * paid, or null. A request may leave a setting out (the intent supplies it);
 * it may not name another one: pay for low, ask for high, get a refusal.
 * The model id is compared exactly, so a second row of the same family is not
 * the same purchase.
 */
export function settingMismatch(
  paid: StoredSettings,
  asked: {
    modelIds?: unknown;
    /** Already normalised; null when the request named none. */
    resolution: string | null;
    quality?: unknown;
    boost?: unknown;
    referenceImageCount: number;
  },
  supportsQuality: boolean,
): string | null {
  const ids = Array.isArray(asked.modelIds) ? asked.modelIds : asked.modelIds == null ? [] : [asked.modelIds];
  if (ids.length && (ids.length !== 1 || ids[0] !== paid.model_id)) return "model";
  if (asked.resolution && asked.resolution !== paid.resolution) return "resolution";
  if (asked.quality != null && supportsQuality && asked.quality !== paid.quality) return "quality";
  if (asked.boost != null && asked.boost !== paid.boost) return "boost";
  if (asked.referenceImageCount !== paid.reference_image_count) return "number of reference images";
  return null;
}
