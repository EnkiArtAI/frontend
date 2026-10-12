"use client";

/** Every surface uses the selected catalogue model and one funded escrow per paid batch. */
import { ensureCdpWallet } from "@/lib/cdp-bridge";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { tooLargeToSend, REFS_TOO_LARGE } from "@/lib/request-size";
import {
  authorizePaidGeneration, cancelPaidGeneration, resumePaidGeneration, CheckoutError,
  type EscrowCheckout, type PaymentSigner, type QuoteRequest,
} from "@/lib/generation-checkout";
import type { CatalogueEntry } from "@/hooks/useModelLimits";

export interface GenerationRequest {
  model: CatalogueEntry | undefined;
  resolution: "1K" | "2K" | "4K";
  quality?: "low" | "medium" | "high";
  boost?: boolean;
  prompt: string;
  promptId?: string;
  variableValues?: Record<string, string>;
  aspectRatio: string;
  referenceImages?: string[];
  workflow?: unknown;
  authoring?: boolean;
}
export type GenerationPhase = "prepare" | "authorization" | "generation";
/** Saved with a failed job so Retry cannot purchase or request the image twice. */
export type GenerationPayment = EscrowCheckout & { unitIndex: number; generationSubmitted: boolean };
export type GenerationOutcome =
  | { ok: true; imageUrl: string; data: Record<string, unknown>; payment?: GenerationPayment }
  | { ok: false; error: string; phase?: GenerationPhase; status?: number; data?: Record<string, unknown>; payment?: GenerationPayment };
function quoteFor(req: GenerationRequest): QuoteRequest {
  return {
    promptId: req.promptId, modelId: req.model!.id, resolution: req.resolution,
    quality: req.model!.supportsQuality ? req.quality : undefined,
    boost: req.boost === true && req.model!.boostAvailable === true,
    referenceImageCount: req.referenceImages?.length ?? 0,
  };
}
function contentFor(req: GenerationRequest) {
  return {
    prompt: req.prompt, variableValues: req.variableValues, aspectRatio: req.aspectRatio,
    referenceImages: req.referenceImages, workflow: req.workflow, authoring: req.authoring,
  };
}
async function generate(req: GenerationRequest, payment?: GenerationPayment, beforeRequest?: () => Promise<void>): Promise<GenerationOutcome> {
  const submitted = payment ? { ...payment, generationSubmitted: true } : undefined;
  try {
    if (submitted) await beforeRequest?.();
    const res = await fetch(req.model!.free ? "/api/generate-free" : "/api/generate-image", {
      method: "POST", headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify(req.model!.free ? {
        ...contentFor(req), modelId: req.model!.id, promptId: req.promptId, resolution: req.resolution,
      } : { ...contentFor(req), intentId: payment!.intentId, unitIndex: payment!.unitIndex }),
    });
    const data = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    if (!res.ok) return { ok: false, phase: "generation", error: typeof data.error === "string" ? data.error : "Generation could not finish.", status: res.status, data, ...(submitted ? { payment: submitted } : {}) };
    return typeof data.imageUrl === "string"
      ? { ok: true, imageUrl: data.imageUrl, data, ...(submitted ? { payment: submitted } : {}) }
      : { ok: false, phase: "generation", error: "No image returned", data, ...(submitted ? { payment: submitted } : {}) };
  } catch {
    return { ok: false, phase: "generation", error: "Connection lost. Check your gallery and payment status before trying again.", ...(submitted ? { payment: submitted } : {}) };
  }
}
/** Paid units share terms, one deposit, and their original indexes. A free unit requires an explicit free-model choice. */
export async function runGenerationBatch(reqs: GenerationRequest[], sign: PaymentSigner,
  onOutcome?: (outcome: GenerationOutcome, index: number) => void,
  resume?: GenerationPayment[], onPayment?: (payments: GenerationPayment[]) => void | Promise<void>): Promise<GenerationOutcome[]> {
  const finishAll = (error: string, phase: GenerationPhase = "prepare", payment: EscrowCheckout | undefined = resume?.[0]) => reqs.map((req, index): GenerationOutcome => {
    const paidIndex = reqs.slice(0, index).filter(item => item.model && !item.model.free).length;
    const out: GenerationOutcome = { ok: false, phase, error,
      ...(payment && (resume?.[index] || (req.model && !req.model.free)) ? { payment: { ...payment, unitIndex: resume?.[index]?.unitIndex ?? paidIndex, generationSubmitted: resume?.[index]?.generationSubmitted ?? false } } : {}) };
    onOutcome?.(out, index);
    return out;
  });
  if (!reqs.length || reqs.length > 24) return finishAll("Choose between one and twenty-four images.");
  if (reqs.some(req => !req.model)) return finishAll("Pick a model first. Nothing was generated and nothing was charged.");
  if (reqs.some(tooLargeToSend)) return finishAll(REFS_TOO_LARGE);
  const paid = reqs.filter(req => !req.model!.free);
  if (reqs.length - paid.length > 1) return finishAll("Only one image from the free model is available each day. Choose a paid model for the remaining images.");
  const quote = paid[0] ? quoteFor(paid[0]) : null;
  if (paid.some(req => JSON.stringify(quoteFor(req)) !== JSON.stringify(quote))) {
    return finishAll("Choose the same paid model and settings for all paid images in this order.");
  }
  if (resume && (paid.length !== reqs.length || resume.length !== reqs.length ||
      resume.some(item => !Number.isInteger(item.unitIndex) || item.unitIndex < 0 ||
        item.unitIndex >= item.units || item.state === "expired" || item.intentId !== resume[0].intentId || item.units !== resume[0].units) ||
      new Set(resume.map(item => item.unitIndex)).size !== resume.length)) {
    return finishAll("This image was already requested. Check your gallery and payment status before placing another order.", "generation", resume[0]);
  }
  let paidIndex = 0;
  const indexes = reqs.map((req, index) => req.model!.free ? undefined : resume?.[index]?.unitIndex ?? paidIndex++);
  const sent = new Set(resume?.filter(item => item.generationSubmitted).map(item => item.unitIndex));
  let checkpointTurn: Promise<void> = Promise.resolve();
  const checkpoint = (checkout: EscrowCheckout) => {
    const operation = checkpointTurn.then(async () => {
      await onPayment?.(indexes.flatMap(unitIndex => unitIndex === undefined ? [] : [{ ...checkout, unitIndex, generationSubmitted: sent.has(unitIndex) }]));
    });
    checkpointTurn = operation.catch(() => undefined);
    return operation;
  };
  let payment: EscrowCheckout | undefined;
  let phase: GenerationPhase = "prepare";
  try {
    if (paid.length) {
      if (!resume) await ensureCdpWallet({ attached: true });
      phase = "authorization";
      payment = resume ? await resumePaidGeneration(resume[0], checkpoint) : await authorizePaidGeneration(quote!, sign, paid.length, checkpoint);
    }
  } catch (error) {
    return finishAll(error instanceof Error ? error.message : "The payment could not be prepared.", phase,
      error instanceof CheckoutError ? error.payment : resume?.[0]);
  }
  const outcomes = await Promise.all(reqs.map(async (req, index) => {
    const unitIndex = indexes[index];
    const unit = unitIndex === undefined ? undefined : payment?.unitStatuses?.find(item => item.unit_index === unitIndex);
    const previous = resume?.[index];
    let result: GenerationOutcome;
    if (unit?.state === "delivered" && unit.imageUrl) {
      result = { ok: true, imageUrl: unit.imageUrl, data: { generationId: unit.generation_id }, payment: { ...payment!, unitIndex: unitIndex!, generationSubmitted: true } };
    } else if (previous?.generationSubmitted || (unit && unit.state !== "pending")) {
      const error = unit?.state === "delivered" ? "This image is already in your gallery." : unit?.state === "failed"
        ? "This image could not finish. Its unused payment is being refunded."
        : "This image was already requested and is still being checked. It will not be requested again.";
      result = { ok: false, phase: "generation", error, payment: { ...payment!, unitIndex: unitIndex!, generationSubmitted: true } };
    } else result = await generate(req, unitIndex === undefined ? undefined : { ...payment!, unitIndex, generationSubmitted: false }, async () => {
      sent.add(unitIndex!);
      await checkpoint(payment!);
    });
    onOutcome?.(result, index);
    return result;
  }));
  // Stops unstarted units after all client requests ended; any in-flight server lease may still finish.
  if (payment) await cancelPaidGeneration(payment).catch(() => undefined);
  return outcomes;
}
export async function runGeneration(req: GenerationRequest, sign: PaymentSigner, resume?: GenerationPayment): Promise<GenerationOutcome> {
  return (await runGenerationBatch([req], sign, undefined, resume ? [resume] : undefined))[0];
}
