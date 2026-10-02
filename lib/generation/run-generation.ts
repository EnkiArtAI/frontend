"use client";

/**
 * The one way every surface starts a generation.
 *
 * Kev, 2026-10-02: "es darf NIEMALS IRGENDEIN standardmodell durchgeschickt
 * werden sondern IMMER DAS AUSGEWÄHLTE!" Each surface used to decide on its
 * own: by price ("0 means free"), by prompt type ("free prompt means the free
 * route"), or by a null model falling through to the free route. Every one of
 * those ended with Flux rendering for a user who had picked something else.
 *
 * Here the selected catalogue entry decides, and nothing else:
 *   no entry          refused, nothing sent
 *   entry.free        /api/generate-free with its id (the server checks it)
 *   anything else     a payment intent for exactly these settings, then
 *                     /api/generate-image, which runs what was paid for
 */
import { sessionAuthHeaders } from "@/lib/session-headers";
import { authorizePaidGeneration, type PaymentSigner } from "@/lib/generation-checkout";
import type { CatalogueEntry } from "@/hooks/useModelLimits";

export interface GenerationRequest {
  /** The resolved catalogue entry the user selected; undefined is refused. */
  model: CatalogueEntry | undefined;
  resolution: "1K" | "2K" | "4K";
  quality?: "low" | "medium" | "high";
  boost?: boolean;
  prompt: string;
  /** A marketplace prompt: its artist share is priced and its text used server-side. */
  promptId?: string;
  variableValues?: Record<string, string>;
  aspectRatio: string;
  referenceImages?: string[];
  workflow?: unknown;
}

export type GenerationOutcome =
  | { ok: true; imageUrl: string; data: Record<string, unknown> }
  | { ok: false; error: string; status?: number; data?: Record<string, unknown> };

export async function runGeneration(req: GenerationRequest, sign: PaymentSigner): Promise<GenerationOutcome> {
  const { model } = req;
  if (!model) return { ok: false, error: "Pick a model first. Nothing was generated and nothing was charged." };

  try {
    let res: Response;
    if (model.free) {
      res = await fetch("/api/generate-free", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({
          modelId: model.id,
          prompt: req.prompt,
          promptId: req.promptId,
          aspectRatio: req.aspectRatio,
          resolution: req.resolution,
          referenceImages: req.referenceImages,
          workflow: req.workflow,
        }),
      });
    } else {
      const { intentId } = await authorizePaidGeneration(
        {
          promptId: req.promptId,
          modelId: model.id,
          resolution: req.resolution,
          quality: model.supportsQuality ? req.quality : undefined,
          boost: req.boost === true,
          referenceImageCount: req.referenceImages?.length ?? 0,
        },
        sign,
      );
      // The settings travel on the intent; the request carries the content.
      res = await fetch("/api/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({
          intentId,
          prompt: req.prompt,
          variableValues: req.variableValues,
          aspectRatio: req.aspectRatio,
          referenceImages: req.referenceImages,
          workflow: req.workflow,
        }),
      });
    }

    const data = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: typeof data.error === "string" ? data.error : `Generation failed (${res.status})`, status: res.status, data };
    }
    return typeof data.imageUrl === "string"
      ? { ok: true, imageUrl: data.imageUrl, data }
      : { ok: false, error: "No image returned", data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Generation failed" };
  }
}
