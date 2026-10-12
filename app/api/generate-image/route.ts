import { NextRequest, NextResponse, after } from "next/server";
import { isDbUnreachable, dbUnavailableResponse, refusalBody } from "@/lib/db-error";
import { generateImagesWithWaveSpeed } from "@/backend/services/wavespeed-image-generation";
import { generateImagesWithOpenAI } from "@/backend/services/openai-image-generation";
import { generateImagesWithGemini } from "@/backend/services/gemini-image-generation";
import type { ImageGenerationRequest } from "@/backend/services/types";
import { referenceImageCount } from "@/lib/generation/provider-capabilities";
import { getSupabaseServerClient, getSupabaseServerClientSafe } from "@/lib/supabaseServer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authRefusal, requireAuth, checkRateLimit } from "@/lib/auth";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { moderate, screenFirst, CLIENT_BLOCK_MESSAGE } from "@/lib/moderation";
import { resolveModel, chooseRoute } from "@/lib/generation/models";
import { normalizeTier, clampTier } from "@/lib/generation/resolution";
import { effectiveQuality } from "@/lib/pricing";
import { reportPriceDrift } from "@/lib/generation/price-drift";
import { toModelFamily } from "@/lib/generation/model-family";
import {
  claimGenerationEscrowUnit, deliverGenerationEscrowUnit, failGenerationEscrowUnit,
  type GenerationEscrowUnitClaim,
} from "@/lib/payments/escrow/server-claims";
import { escrowServerChain, EscrowPaymentError } from "@/lib/payments/escrow/server-chain";
import { advanceGenerationEscrow } from "@/lib/payments/escrow/server-lifecycle";
import { settingMismatch, type StoredSettings } from "@/lib/payments/generation-settings";
import { loadPromptText, fillVariables, inputsUnmatched, overLong, VALUE_MAX } from "@/lib/generation/prompt-text";
import { checkPrompt, NOT_CHECKED, textValues } from "@/lib/moderation/prompt-check";
import { recordWarning, warningMessage } from "@/lib/moderation/warnings";
import { ADULT_REFUSAL, adultConfirmed, promptMarkedAdult } from "@/lib/adult-content";
import { recordExtractionHit, SILENT_FAILURE, silentFailure } from "@/lib/moderation/extraction-hits";
import { reportSuccess, reportFailure } from "@/lib/generation/provider-health";
import { childSafetyScore, recordModerationEvent } from "@/lib/moderation-enforcement";
import {
  recordGeneration, recordGenerationReferences, recordGenerationRenditions, resolveRecordingUserId,
  recordGenerationFailure, GenerationRecordError, type GenerationFailure,
} from "@/lib/generation/record";
import { storeReferenceImages } from "@/lib/generation/reference-images";
import { putDurably, removeStored, storeDeadline } from "@/lib/generation/derivative-store";
import { checkImageBytes, dataUrlBytes, heldBack, isLink, IMAGE_REFUSED, IMAGE_UNCHECKED, REFERENCE_LINK, REFERENCE_REFUSED, REFERENCE_UNCHECKED } from "@/lib/moderation/image-check-bytes";
import { recordImageCase } from "@/lib/moderation/image-case";
import { acquireSlot, releaseSlot } from "@/lib/generation/concurrency";
import { stripWorkflowImages } from "@/lib/generation/workflow";

// Provider timeout and storage must finish before the platform kills this
// function. A killed unit stays leased until its database lease expires.
export const maxDuration = 300;

// Five budgets that MUST stay in this order, or a generation that is still
// running gets treated as dead by something downstream:
//
//   285s  this timeout      give up in-process, with time left to upload,
//                           record and answer inside the platform budget
//   285s  storeDeadline     (lib/generation/derivative-store.ts) counted from
//                           the request, not the provider call: the stored
//                           image must have landed before delivery is recorded
//   300s  maxDuration       the platform kills the function here
//   330s  SLOT_TTL_MS       (lib/generation/concurrency.ts) a killed function
//                           must not free its slot before it is truly gone
//   360s  unit lease       a claim is only dead once every step above is
//
// Raising maxDuration alone inverts it: at 300s the slot expires at 150s and
// the claim expires at 180s while the generation is still legitimately
// running — the concurrency cap silently breaks and a live payment is undone.
// 15s of headroom, not a round guess. Measured 2026-08-07 on the largest real
// output we have (3840x2160, 13.92 MB PNG from bench-output/): the sharp
// derivatives cost 250ms. The rest of the headroom is for moving roughly 14 MB
// down from the provider and 14 MB up into blob storage, which cannot be
// measured from a dev machine — hence 15s rather than 1s.
//
// Raising it further buys nothing: the slowest generation ever measured here
// is 78.1s (WaveSpeed nano-banana-pro at 2K), so this bound is never what ends
// a real request. It only decides how long a HUNG one makes the user wait
// before it can answer with something they can act on.
const SOLANA_GENERATION_TIMEOUT_MS = 285_000;

type GenerateImageBody = {
  prompt?: string;
  aspectRatio?: string;
  resolution?: string;
  modelIds?: string[];
  /** Spend more to run the same model directly instead of via WaveSpeed. */
  boost?: boolean;
  /** Data URLs or bare base64. Capped server-side by the model's own limit. */
  referenceImages?: string[];
  /** low | medium | high, for models that take it. Ignored by the rest. */
  quality?: "low" | "medium" | "high";
  /** The editor node graph. Image bytes inside it are extracted server-side. */
  workflow?: unknown;
  ratio?: string;
  /** Values for a marketplace prompt's [name] slots, filled on the server. */
  variableValues?: Record<string, string>;
  /** A funded escrow, prepared from the stored payment intent. */
  intentId?: string;
  /** One server-reserved image within this funded batch, never a delivered count. */
  unitIndex?: number;
  /** An artist's draft from an editor: no moderator may read it. */
  authoring?: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export async function POST(request: NextRequest) {
  // The clock maxDuration runs on; the image must be stored inside it.
  const startedAt = Date.now();
  // JSON only, before anything runs, like the free route: a page elsewhere
  // must not post here in a visitor's name as a form or plain text, which
  // browsers send unasked.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Send the request as JSON." }, { status: 415 });
  }
  let consumedUnit: { supabase: SupabaseClient; claim: GenerationEscrowUnitClaim } | null = null;
  // What a failure from the concurrency cap on is recorded with, for the admin person list.
  let failCtx: Omit<GenerationFailure, "error"> | null = null;
  const scheduleReconciliation = (held: { supabase: SupabaseClient; claim: GenerationEscrowUnitClaim }) => {
    after(async () => {
      try {
        await advanceGenerationEscrow(held.supabase, escrowServerChain(), held.claim.intentId, held.claim.owner);
      } catch {
        console.error("[escrow] reconciliation pending", held.claim.intentId);
      }
    });
  };
  const failIfClaimed = async () => {
    if (!consumedUnit) return;
    const held = consumedUnit;
    consumedUnit = null;
    try { await failGenerationEscrowUnit(held.supabase, held.claim); }
    catch { console.error("[escrow] image request failure pending", held.claim.intentId); }
    scheduleReconciliation(held);
  };

  // Held for the length of the generation. Declared out here so EVERY exit —
  // success, provider failure, the catch-all — gives it back: a leaked slot
  // locks the user out until it expires, which is the failure a concurrency
  // cap must not introduce.
  let heldSlot: { supabase: SupabaseClient | null; id: string } | null = null;
  const releaseHeldSlot = async () => {
    if (heldSlot) {
      await releaseSlot(heldSlot.supabase, heldSlot.id);
      heldSlot = null;
    }
  };

  try {
    const body = (await request.json()) as GenerateImageBody;
    const typedPrompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";

    /* The resolution is validated ONCE, here, and every read below uses the
       result. It used to travel as the raw client string and get cast to the
       tier union unchecked at the point of use — this route has no schema, only
       prompt and intentId are shape-checked. So a lowercase "4k", which the
       editor surfaces genuinely send, reached WaveSpeed's RESOLUTION_MAP, missed
       every key, and fell back to '1k' — the SMALLEST tier — while the price
       ladder below read the same string and charged for 4K. Refusing an
       unreadable value is the only answer that cannot end in a buyer paying for
       pixels nobody asked the provider for. */
    const askedResolution = body.resolution == null ? null : normalizeTier(body.resolution);
    if (body.resolution != null && askedResolution === null) {
      return NextResponse.json(
        { error: "Choose a supported image size: 1K, 2K or 4K." },
        { status: 400 },
      );
    }

    /* A PAID request is told which model it bought; it does not get to pick
     * one here.
     *
     * The buyer surface sends { intentId, prompt, aspectRatio } and no
     * modelIds — it already named the model when it took the quote, and
     * model_family was written onto the intent and PRICED from it. Resolving
     * from body.modelIds anyway meant falling back to DEFAULT_MODEL
     * ("Nano Banana Pro"), so the later family comparison refused every
     * GPT-Image-2 purchase.
     *
     * Read before the preflight on purpose: this same object decides the
     * routing, the reference-image eligibility and the quote below, so
     * learning the family after those were settled would only have let us
     * complain about them rather than get them right. Session ownership is
     * checked before the quote is read or a metered preflight can run. */
    const intentId = typeof body.intentId === "string" ? body.intentId.trim() : "";
    // Intents only (REC-4): the legacy X-PAYMENT rail paid first and generated
    // second, so a failed generation kept the money. Free models have their
    // own route, /api/generate-free.
    if (!intentId) {
      return NextResponse.json(
        { error: "A paid generation needs a payment intent. No image was generated. Check your payment status before trying again." },
        { status: 402 },
      );
    }
    if (!UUID_RE.test(intentId)) {
      return NextResponse.json({ error: "Choose a valid image request before continuing." }, { status: 400 });
    }

    const unitIndex = body.unitIndex;
    if (!Number.isInteger(unitIndex) || unitIndex! < 0 || unitIndex! >= 24) {
      return NextResponse.json({ error: "Choose a valid image request." }, { status: 400 });
    }

    // Login and the rate limits come before the checks below: each of them
    // is a paid call, so a caller without a session, or over the limit,
    // never reaches one.
    const ipLimit = checkRequestRateLimit(rateLimitKey(request, "generate:intent:ip"), 120, 60_000);
    if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

    // Session token only — requireAuth's fallback (X-Wallet-Address
    // signature headers, no server nonce) is replayable and deliberately
    // not accepted on payment paths (same gate as payments/generation/pay).
    if (!request.headers.get("X-Session-Token")) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    let authUser;
    try {
      authUser = await requireAuth(request);
    } catch (e) {
      return authRefusal(e);
    }
    if (!checkRateLimit(authUser.userId, "generate:intent", 60, 60_000)) {
      return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    }

    const supabase = getSupabaseServerClient();
    const recordingUserId = await resolveRecordingUserId(supabase, request);
    if (!recordingUserId) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    /* The intent is the sum of settings the buyer paid for (REC-4): the exact
       model row, the resolution, the quality that runs, boost and how many
       reference images. Everything below runs those and nothing the request
       body says instead. */
    const { data: intentRow, error: intentError } = await (getSupabaseServerClientSafe()
      ?.from("generation_payment_intents")
      .select("model_id, model_family, resolution, quality, boost, reference_image_count, prompt_id, artist_amount_micro")
      .eq("id", intentId)
      .ilike("buyer_wallet", authUser.walletAddress)
      .maybeSingle() ?? Promise.resolve({ data: null, error: null }));
    if (isDbUnreachable(intentError)) return dbUnavailableResponse();
    const paid = intentRow as
      | (StoredSettings & { model_family: string; prompt_id: string | null; artist_amount_micro: number })
      | null;
    if (!paid) {
      return NextResponse.json(
        { error: "Payment intent not found. No image was generated. Check your payment status before trying again." },
        { status: 404 },
      );
    }

    /* A marketplace prompt with an artist share is generated from the
       ARTIST's text, filled with the buyer's variables, never from what the
       client sends: the client only ever sees a paid prompt's excerpt, so it
       sent the title and the variables, and the buyer paid the artist for an
       image the artist's prompt never made. Free and own prompts take the
       buyer's own text. The artist's text is never returned to the buyer. */
    const fromArtist = Boolean(paid.prompt_id) && Number(paid.artist_amount_micro) > 0;
    let prompt = typedPrompt;
    let promptAdult = false;
    if (fromArtist) {
      const text = await loadPromptText(getSupabaseServerClient(), paid.prompt_id as string);
      if (!text.ok) return NextResponse.json(refusalBody(text), { status: text.status });
      if (overLong(body.variableValues)) {
        return NextResponse.json(
          { error: `Each input can be at most ${VALUE_MAX} characters. No image was generated. Check your payment status before trying again.` },
          { status: 422 },
        );
      }
      const filled = fillVariables(text.text, body.variableValues, text.variables);
      // A buyer must never pay for an image a value of theirs did not reach.
      if (inputsUnmatched(filled)) {
        return NextResponse.json(
          { error: "This prompt's inputs could not be matched to its text. No image was generated. Check your payment status before trying again." },
          { status: 422 },
        );
      }
      prompt = filled.text;
      promptAdult = text.adult;
    } else if (paid.prompt_id) {
      const marked = await promptMarkedAdult(getSupabaseServerClient(), paid.prompt_id as string);
      if (marked === null) {
        return NextResponse.json({ error: "This prompt could not be checked right now. No image was generated. Check your payment status before trying again." }, { status: 503 });
      }
      promptAdult = marked;
    }
    if (!prompt) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    // --- SECURITY GUARDS ---
    // 1. Prompt length cap (client text; an artist's prompt is not the buyer's to size)
    if (!fromArtist && prompt.length > 4000) {
      return NextResponse.json({ error: "Prompt too long" }, { status: 400 });
    }

    // 2. Variable injection guard
    const bracketCount = (prompt.match(/\[/g) || []).length;
    if (!fromArtist && bracketCount > 20) {
      return NextResponse.json({ error: "Too many variables" }, { status: 400 });
    }

    const paidTier = normalizeTier(paid.resolution);
    const paidModel = paid.model_id ? await resolveModel(getSupabaseServerClientSafe(), [paid.model_id]) : null;
    if (!paidTier || !paidModel || toModelFamily(paidModel.name) !== paid.model_family) {
      // The row it paid for is gone or changed family. Generating on anything
      // else would be the exact substitution this path exists to prevent.
      return NextResponse.json(
        { error: "This paid model is unavailable right now. Check your payment status before trying again." },
        { status: 409 },
      );
    }
    // A setting the request repeats must agree with the payment, refused here
    // before the slot and the claim, so there is nothing to void, and before
    // the checks below, so they judge no more images than were paid for.
    const attachedRefs = referenceImageCount(body.referenceImages);
    const mismatch = settingMismatch(
      paid,
      { modelIds: body.modelIds, resolution: askedResolution, quality: body.quality, boost: body.boost, referenceImageCount: attachedRefs },
      paidModel.supportsQuality,
    );
    if (mismatch) {
      return NextResponse.json(
        { error: "The selected settings differ from this payment. Check its status before starting a new order." },
        { status: 400 },
      );
    }
    // Never sliced away below: a reference the model cannot take is refused.
    if (attachedRefs > paidModel.maxRefs) {
      return NextResponse.json(
        { error: `${paidModel.name} takes at most ${paidModel.maxRefs} reference images. No image was generated. Check your payment status before trying again.` },
        { status: 422 },
      );
    }

    // What the prompt asks for, judged before anything is generated or
    // charged: for an artist's prompt the buyer's values only (the artist's
    // text never goes out for this), otherwise the whole prompt. An explicit
    // or child-safety request is refused with a warning the user sees; an
    // extraction attempt and an outage of the check both answer like any
    // failed generation.
    const checked = fromArtist ? textValues(body.variableValues) : { prompt };
    // A record of an artist's prompt names it and shows the buyer's values,
    // never its text; an artist's draft from an editor shows nothing, marked
    // as withheld on the requester's word, for any session token (as on the
    // free route; lib/moderation/evidence).
    const authoring = !fromArtist && body.authoring === true && Boolean(request.headers.get("X-Session-Token"));
    const about = fromArtist ? { promptId: String(paid.prompt_id) } : authoring ? { withheld: prompt, draft: true } : {};
    // The regex first: what Tier 1 refuses never reaches the chat model, and
    // its refusal is this request's moderation verdict (Kev, 2026-10-06).
    const first = screenFirst(checked);
    // Every reference image is judged too, beside the prompt, before it can
    // reach a model or anything is charged (Kev, 2026-10-08: every image).
    // They arrive as data: URLs or bare base64, as the providers read them.
    const refs = (body.referenceImages ?? []).filter((r): r is string => typeof r === "string" && r.trim() !== "");
    // A link is never fetched here: refused as one, not judged as junk and
    // answered "try again".
    if (refs.some(isLink)) {
      return NextResponse.json({ error: REFERENCE_LINK }, { status: 422 });
    }
    const refBytes = refs.map((r) => dataUrlBytes(r) ?? Buffer.from(r.trim(), "base64"));
    const [check, refsSeen] = await Promise.all([
      first ? NOT_CHECKED : checkPrompt(checked, { hidden: fromArtist, signal: request.signal }),
      Promise.all(refBytes.map((b) => checkImageBytes(b, { signal: request.signal }))),
    ]);
    // A child-safety reference becomes a case whatever else refuses the
    // request, the prompt's own warning below included.
    refsSeen.forEach((v, i) => {
      if (v.verdict === "child_safety") {
        after(recordImageCase(getSupabaseServerClient(), {
          surface: "generate-image", request, bytes: refBytes[i], scores: v.scores,
          about: authoring ? "" : JSON.stringify(checked), promptId: about.promptId,
        }));
      }
    });
    if (check.verdict === "minor_sexual" || check.verdict === "explicit_sexual") {
      const outcome = await recordWarning(getSupabaseServerClient(), {
        surface: "generate-image", request, category: check.verdict, text: authoring ? "" : JSON.stringify(checked), confidence: check.confidence, ...about,
      });
      return NextResponse.json({ error: warningMessage(check.verdict, outcome) }, { status: 422 });
    }
    // A reference the check refuses or cannot judge stops the request before
    // the slot and the claim, so there is nothing to void.
    if (refsSeen.some(heldBack)) {
      return refsSeen.some((v) => v.verdict === "blocked" || v.verdict === "child_safety")
        ? NextResponse.json({ error: REFERENCE_REFUSED }, { status: 422 })
        : NextResponse.json({ error: REFERENCE_UNCHECKED }, { status: 503 });
    }
    if (check.verdict === "unavailable") console.warn("[prompt-check] unavailable:", check.reason);
    // Refused silently, but only where a real generation fails: after the
    // slot and the claim (below). Answering here, before those, told a
    // caller which inputs were caught.
    const silent = check.verdict !== "clear";

    // 18+ (a suggestive prompt, or a prompt marked 18+) is for confirmed adults
    // only, refused before anything is charged.
    // Whatever else the check found, so the refusal never depends on it.
    // A reference judged 18+ makes the render 18+ too.
    const adult = ("adult" in check && check.adult === true) || promptAdult || refsSeen.some((v) => v.verdict === "adult");
    const asker = adult ? recordingUserId : null;
    if (adult && !(await adultConfirmed(getSupabaseServerClient(), asker))) {
      // Counted only for a signed-in account: this answer comes before login,
      // where nothing would stop a loop filling the queue and the admins' inbox.
      if (check.verdict === "extraction" && asker) {
        after(recordExtractionHit(getSupabaseServerClient(), { surface: "generate-image", request, values: checked, confidence: check.confidence, ...about }));
      }
      return NextResponse.json(ADULT_REFUSAL, { status: 403 });
    }

    // 3. Content moderation — deliberately the FIRST thing after cheap input
    // validation and long before any payment step below. A refused prompt must
    // never be a charged prompt.
    //
    // The client only ever learns that it was refused: category, tier, rule ids
    // and scores stay server-side, otherwise this endpoint becomes an oracle an
    // attacker can probe to map the filter.
    // The prompt check saw only the buyer's values of an artist's prompt, so
    // tier 2 keeps its sexual flag for the artist's text unless the prompt is
    // marked 18+ (legacy prompts were never judged at save).
    const verdict = first ?? await moderate({ prompt, surface: "generate-image", signal: request.signal, adultJudged: !fromArtist || promptAdult });
    // A child-safety hit on a marketplace prompt is a warning on the buyer's
    // ladder, and that warning is its one record: it weighs ten, so it
    // suspends at once, and every repeat climbs the ladder to a ban for good
    // (Kev, 2026-10-03: whoever keeps at it is banned).
    const minors = fromArtist && !verdict.allowed ? childSafetyScore(verdict) : null;
    if (minors !== null) {
      const outcome = await recordWarning(getSupabaseServerClient(), {
        surface: "generate-image", request, category: "minor_sexual", text: JSON.stringify(checked), confidence: minors, scores: verdict.scores, ...about,
      });
      return NextResponse.json({ error: warningMessage("minor_sexual", outcome) }, { status: 422 });
    }
    // after() and not a bare void: on a block this route returns immediately,
    // and a floating promise can be frozen with the lambda before the insert
    // lands — losing exactly the events we most want recorded.
    after(recordModerationEvent(verdict, { surface: "generate-image", request, prompt: fromArtist ? JSON.stringify(checked) : authoring ? "" : prompt, ...about }));
    if (!verdict.allowed) {
      return NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 });
    }

    // 3. Ratio validation (fetched from DB)
    if (body.modelIds && body.modelIds.length > 0 && body.ratio && body.ratio !== "Any ratio") {
      try {
        const supabase = getSupabaseServerClientSafe();
        if (supabase) {
          const { data: models } = await supabase
            .from("models")
            .select("id, allowed_ratios")
            .in("id", body.modelIds);
          const allowed = (models || []).some((m: any) =>
            m.allowed_ratios?.includes(body.ratio as string)
          );
          if (!allowed) {
            return NextResponse.json({ error: "Ratio not allowed for selected model(s)" }, { status: 400 });
          }
        }
      } catch {
        /* skip validation if DB unavailable */
      }
    }

    const preflightModel = paidModel;
    // Chosen HERE and nowhere else, because the quote below carries the price
    // of a specific host: quoting AceData and then generating on WaveSpeed
    // would charge the wrong amount. This also skips hosts whose breaker is
    // open, so an outage costs a fallback rather than a failed payment.
    /* Reference images decide WHICH host is even eligible, which is why the
     * count is computed here, before the route is chosen and long before the
     * quote. Only hosts that can pass images to the model are considered, so a
     * prompt with references takes the Gemini row rather than the cheaper
     * WaveSpeed one that would discard them. */
    /* The quality that will RUN, not the one that was sent: the OpenAI
       service defaults an unstated quality by tier, and gpt's routes carry
       applies_when quality conditions that fail CLOSED on a missing value —
       routing on the raw body value would drop every conditioned row for
       callers without a quality lever (quick create). One value feeds the
       route, the price and the provider call. */
    const effQuality = preflightModel.supportsQuality
      ? effectiveQuality(paidTier, paid.quality)
      : null;
    const preflightRoute = await chooseRoute(
      getSupabaseServerClientSafe(),
      preflightModel,
      {
        boost: paid.boost,
        quality: effQuality,
        resolution: preflightModel.supportsResolution ? paidTier : null,
        referenceImages: attachedRefs,
      },
    );

    /* No host can carry these images. Refuse, and say so, rather than
     * generating without them.
     *
     * This is the case the whole capability layer exists for. Until
     * 2026-08-12 the request went through on the cheapest host, the images
     * were dropped somewhere below this line, and the buyer was charged in
     * full for a picture that had never seen them. Nothing surfaced it: the
     * output is a perfectly plausible answer to the prompt. 422 rather than
     * 501 — the request is well formed, the combination is simply not
     * available. */
    if (!preflightRoute) {
      return NextResponse.json(
        {
          error:
            `${preflightModel.name} cannot use reference images. ` +
            `No image was generated. Check your payment status before trying again. ` +
            `Choose a model that accepts them, or remove the ${attachedRefs} attached image${attachedRefs === 1 ? "" : "s"}.`,
        },
        { status: 422 },
      );
    }

    // No free host: a paid model never renders on Pollinations' Flux.
    const IMPLEMENTED: readonly string[] = ["gemini", "wavespeed", "openai"];
    if (!IMPLEMENTED.includes(preflightRoute.provider)) {
      return NextResponse.json(
        { error: `${preflightModel.name} is not available yet.` },
        { status: 501 },
      );
    }
    // A paid request never falls back to a guessed model (Kev, 2026-09-22).
    if (!preflightRoute.providerModel) {
      return NextResponse.json(
        { error: `${preflightModel.name} is temporarily unavailable. Check your payment status before trying again.` },
        { status: 503 },
      );
    }

    // 3c. Concurrency cap — before any payment step, so a refused request is
    // never a charged one. Unlimited unless an admin sets a number.
    const slotSupabase = supabase;
    const slotUserId = recordingUserId;
    failCtx = {
      request, surface: "generate-image", modelId: paid.model_id ?? null, resolution: paidTier ?? null, quality: effQuality,
      boost: paid.boost === true, aspectRatio: body.aspectRatio || body.ratio || null, referenceImageCount: attachedRefs,
      // For an artist's prompt only the buyer's values, for an artist's draft
      // nothing: an artist's text is never stored with a failure.
      prompt: fromArtist ? JSON.stringify(textValues(body.variableValues)) : authoring ? null : prompt, intentId,
    };
    const slot = await acquireSlot(slotSupabase, slotUserId);
    if (slot.slotId) heldSlot = { supabase: slotSupabase, id: slot.slotId };
    if (!slot.allowed) {
      return NextResponse.json(
        {
          error:
            `You already have ${slot.limit} generation${slot.limit === 1 ? "" : "s"} running. ` +
            `Wait for one to finish.`,
          retryable: true,
        },
        { status: 429 },
      );
    }

    const enhancedPrompt = prompt;

    // A conditional per-image lease prevents a replay or parallel request
    // from reaching a provider twice. The session binds both buyer and user.
    const paymentChain = escrowServerChain();
    const claim = await claimGenerationEscrowUnit(supabase, paymentChain, {
      intentId, owner: authUser.walletAddress, userId: recordingUserId, unitIndex: unitIndex!,
    });
    consumedUnit = { supabase, claim };
    const paymentMetadata = {
      paymentIntentId: intentId, unitIndex, modelFamily: paid.model_family, resolution: paid.resolution,
    };

    // Every request here holds a payment — bound the provider call so a hung
    // generation can't strand it.
    // The model the user actually picked, resolved to a provider model id.
    // Without this the service fell back to a hard coded model for every
    // generation, so the choice in the UI changed nothing while the price
    // was charged per selection.
    // Resolved once, in the pre-payment guard above — a second lookup could
    // disagree with the one the refusal was based on.
    const chosen = preflightModel;
    const route = preflightRoute;
    const shared = {
      prompt: enhancedPrompt,
      modelVersion: route.providerModel,
      aspectRatio: (body.aspectRatio || body.ratio || "1:1") as ImageGenerationRequest["aspectRatio"],
      // Only sent to models that honour it. Asking a model without imageSize
      // for 2K silently returns 1024² — and we would still have charged for 2K.
      /* Clamped to what the CHOSEN route renders, not to what was asked.
         The router can fail over to a different host mid-request, and asking
         a host for a tier it does not have is how a 4K charge came back as a
         1K picture with nothing reporting it. */
      imageSize: chosen.supportsResolution
        ? (clampTier(
            paidTier,
            route.provider,
            route.providerModel,
          ) as ImageGenerationRequest["imageSize"])
        : undefined,
      // Reference images reached the model for the first time here: they were
      // uploaded, counted against the per-model cap and stored, and then
      // dropped before the request was built.
      // Sent only where it means something — and as the EFFECTIVE value,
      // the same one that chose the route and priced the request.
      quality: chosen.supportsQuality ? (effQuality ?? undefined) : undefined,
      // Exactly the count paid for, already checked against the model above.
      referenceImages: body.referenceImages,
      numImages: 1,
    };

    // The silent refusal fails exactly like a provider failure: the claim goes
    // back the same way, the answer is the same, and it takes as long. Only a
    // request that got this far counts as a caught attempt.
    if (silent) {
      if (check.verdict === "extraction") {
        after(recordExtractionHit(getSupabaseServerClient(), { surface: "generate-image", request, values: checked, confidence: check.confidence, ...about }));
      }
      // The wait comes first: a provider failure holds the claim and the slot
      // until it answers, so a second request meanwhile must see them taken.
      const answer = await silentFailure();
      await failIfClaimed();
      await releaseHeldSlot();
      return answer;
    }

    // Boost picks WHERE the model runs, never which model. WaveSpeed hosts
    // the same Nano Banana Pro at ~73-78s; going direct costs more and takes
    // ~19-39s. Same picture either way — the user is buying time.
    //
    // One switch over the resolved provider, so adding a host is a case here
    // and a row in model_providers — not a new branch scattered through the
    // request flow, which is how the free path ended up special-cased in its
    // own route with no price, no ratio list and no reference limit.
    const geminiRequest =
      route.provider === "wavespeed"
        ? generateImagesWithWaveSpeed(shared)
        : route.provider === "openai"
          ? generateImagesWithOpenAI(shared)
          : generateImagesWithGemini(shared);

    const geminiResult = await withTimeout(
      geminiRequest,
      Math.min(SOLANA_GENERATION_TIMEOUT_MS, Math.max(1, storeDeadline(startedAt) - Date.now())),
      "Image generation timed out after payment. Please try again with a shorter prompt or lower resolution."
    );

    if (!geminiResult.success || !geminiResult.imageBuffers?.length) {
      // Tell the breaker. It classifies: a refused prompt says nothing about
      // the host and never counts, while a dead key or an empty balance
      // takes every route of that provider out at once.
      if (route.modelProviderId && route.providerId) {
        after(
          reportFailure(
            getSupabaseServerClient(),
            route.modelProviderId,
            route.providerId,
            geminiResult.error || "generation failed",
          ),
        );
      }
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: geminiResult.error || "generation failed" }));
      await failIfClaimed();
      await releaseHeldSlot();
      // The provider's own text stays in the logs and the failure record; the
      // buyer gets the answer a caught request gets, so the two cannot be told apart.
      return NextResponse.json(SILENT_FAILURE, { status: 500 });
    }

    // A delivered image resets the count, so three unrelated blips spread
    // over a week never add up to an outage.
    if (route.modelProviderId && route.providerId) {
      after(reportSuccess(getSupabaseServerClient(), route.modelProviderId, route.providerId));
    }
    /* Runtime price-drift check: the vendor's bill for THIS image against
       the cell we charge by. A repriced provider is noticed on the first
       image, and the admins are mailed (Kev, 2026-09-05). */
    if (typeof geminiResult.usage?.costUsd === "number") {
      after(reportPriceDrift(getSupabaseServerClientSafe(), {
        provider: route.provider,
        modelFamily: toModelFamily(chosen.name),
        resolution: paidTier,
        quality: effQuality,
        observedUsd: geminiResult.usage.costUsd,
      }));
    }

    const generatedImageBuffer = geminiResult.imageBuffers?.[0];
    if (!generatedImageBuffer) {
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: "No generated image buffer returned" }));
      await failIfClaimed();
      await releaseHeldSlot();
      return NextResponse.json(SILENT_FAILURE, { status: 500 });
    }

    // Escrow delivery needs an image stored independently of this response.
    const storedName = `generations/${Date.now()}_${Math.random().toString(36).substring(2, 9)}.png`;
    const imageUrl = await putDurably(
      storedName, generatedImageBuffer, "image/png", storeDeadline(startedAt),
    );
    // Leave time to persist delivery and answer before the platform's kill.
    if (!imageUrl || Date.now() > storeDeadline(startedAt)) {
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: "image could not be stored" }));
      await failIfClaimed();
      await releaseHeldSlot();
      return NextResponse.json(
        { error: "Your image was made but could not be delivered. Nothing was charged. Please try again." },
        { status: 503 },
      );
    }

    // The image check, after storage and before the money moves (Kev,
    // 2026-10-08): what it refuses or cannot judge is not delivered and not
    // charged, and the stored copy comes down again (both stores: an aborted
    // Blob turn may still have landed one). Bounded by the store deadline, so
    // delivery recording keeps its reserve.
    const seen = await checkImageBytes(generatedImageBuffer, {
      // Not the request's signal: a buyer who closes the tab still gets the
      // render they paid for in the gallery.
      signal: AbortSignal.timeout(Math.max(1, storeDeadline(startedAt) - Date.now())),
    });
    if (heldBack(seen)) {
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: `image check: ${seen.verdict}` }));
      if (seen.verdict === "child_safety") {
        after(recordImageCase(getSupabaseServerClient(), {
          surface: "generate-image", request, bytes: generatedImageBuffer, scores: seen.scores,
          about: authoring ? "" : JSON.stringify(checked), promptId: about.promptId,
        }));
      }
      after(removeStored([imageUrl, storedName]));
      await failIfClaimed();
      await releaseHeldSlot();
      return seen.verdict === "unavailable"
        ? NextResponse.json({ error: IMAGE_UNCHECKED }, { status: 503 })
        : NextResponse.json({ error: IMAGE_REFUSED }, { status: 422 });
    }

    // Settlement's k comes from accepted image rows linked to the leased
    // units. Save both rows before acknowledging this unit as delivered.
    const m = geminiResult.metadata as {
      resolution?: string | null; bytes?: number | null; format?: string | null;
    } | undefined;
    const dims = m?.resolution?.split("x") ?? [];
    const stripped = stripWorkflowImages(body.workflow ?? {});
    const generationId = await recordGeneration(supabase, {
      adult: adult || seen.verdict === "adult", userId: recordingUserId,
      promptId: paid.prompt_id ?? null, finalPrompt: prompt, effectivePrompt: enhancedPrompt,
      variableValues: body.variableValues ?? {}, model: preflightModel, route: preflightRoute,
      boost: paid.boost, aspectRatio: body.aspectRatio || body.ratio || null,
      resolution: paidTier, seed: null,
      output: dims.length === 2 && m?.bytes
        ? { width: Number(dims[0]) || 0, height: Number(dims[1]) || 0, bytes: m.bytes, format: m.format ?? "" }
        : null,
      imageUrl, previewUrl: null, thumbnailUrl: null,
      generationMs: geminiResult.generationTime ?? null,
      workflow: stripped.workflow, workflowTexts: stripped.texts, chainKey: paymentChain.cluster,
    }, { requireAcceptedImage: true });
    if (!generationId) throw new GenerationRecordError();
    const held = consumedUnit;
    if (!held) throw new GenerationRecordError();
    let reconciliationPending = false;
    try {
      await deliverGenerationEscrowUnit(supabase, held.claim, generationId);
    } catch {
      // A lost acknowledgement may hide a committed delivery. This RPC is
      // idempotent, and a failure can never undo an already delivered unit.
      try { await deliverGenerationEscrowUnit(supabase, held.claim, generationId); }
      catch { reconciliationPending = true; await failIfClaimed(); }
    }
    if (consumedUnit) {
      consumedUnit = null;
      scheduleReconciliation(held);
    }
    // Input history is optional. Slow reference uploads cannot hold delivery
    // or alter the database count used for settlement.
    after(async () => {
      try {
        const references = await storeReferenceImages(
          stripped.images.length ? stripped.images.map((img) => (refs.includes(img) ? img : "")) : refs,
          recordingUserId,
        );
        await recordGenerationReferences(supabase, generationId, references);
      } catch { console.error("[generation] input history pending", generationId); }
    });
    after(async () => {
      try {
        await recordGenerationRenditions(supabase, generationId, recordingUserId, imageUrl, storeDeadline(startedAt));
      } catch { console.error("[generation] image previews pending", generationId); }
    });

    await releaseHeldSlot();

    // Return image with payment metadata and headers
    return NextResponse.json(
      {
        imageUrl,
        prompt: fromArtist ? undefined : enhancedPrompt,
        provider: preflightRoute.provider,
        model: geminiResult.metadata?.model || preflightRoute.providerModel,
        generationTime: geminiResult.generationTime,
        paymentScheme: "escrow",
        generationId,
        reconciliationPending,
        metadata: {
          ...paymentMetadata,
          geminiMetadata: geminiResult.metadata,
        },
      },
      { status: 200 },
    );
  } catch (e: unknown) {
    if (e instanceof EscrowPaymentError) {
      await failIfClaimed();
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    if (e instanceof GenerationRecordError) {
      await failIfClaimed();
      return NextResponse.json({
        error: "Your image could not be saved. Its payment is being reconciled. Please check your history before starting a new request.",
        refundPending: true,
      }, { status: 503 });
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error("Generate image error:", message);
    if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: message }));
    await failIfClaimed();
    // An outage before anything was charged is said as one, not as "sign in"
    // or a failed generation.
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    return NextResponse.json(SILENT_FAILURE, { status: 500 });
  } finally {
    // Unavoidable, because the early returns between taking the slot and
    // answering are the ones that matter: a refused claim leaking its slot
    // would refuse the buyer's retry too. releaseHeldSlot() nulls its own
    // reference, so the explicit calls on the success and failure paths stay
    // correct.
    await releaseHeldSlot();
  }
}
