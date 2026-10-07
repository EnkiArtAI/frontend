import { NextRequest, NextResponse, after } from "next/server";
import { generateImagesWithWaveSpeed } from "@/backend/services/wavespeed-image-generation";
import { generateImagesWithOpenAI } from "@/backend/services/openai-image-generation";
import { generateImagesWithGemini } from "@/backend/services/gemini-image-generation";
import type { ImageGenerationRequest } from "@/backend/services/types";
import { referenceImageCount } from "@/lib/generation/provider-capabilities";
import { getSupabaseServerClient, getSupabaseServerClientSafe } from "@/lib/supabaseServer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth, checkRateLimit } from "@/lib/auth";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { moderate, screenFirst, CLIENT_BLOCK_MESSAGE } from "@/lib/moderation";
import { resolveModel, chooseRoute } from "@/lib/generation/models";
import { normalizeTier, clampTier } from "@/lib/generation/resolution";
import { effectiveQuality } from "@/lib/pricing";
import { reportPriceDrift } from "@/lib/generation/price-drift";
import { toModelFamily } from "@/lib/generation/model-family";
import { claimForGeneration, type ClaimMode } from "@/lib/payments/generation-claim";
import { settingMismatch, type StoredSettings } from "@/lib/payments/generation-settings";
import { loadPromptText, fillVariables, inputsUnmatched, overLong, VALUE_MAX } from "@/lib/generation/prompt-text";
import { checkPrompt, NOT_CHECKED, textValues } from "@/lib/moderation/prompt-check";
import { recordWarning, warningMessage } from "@/lib/moderation/warnings";
import { ADULT_REFUSAL, adultConfirmed, promptMarkedAdult } from "@/lib/adult-content";
import { recordExtractionHit, SILENT_FAILURE, silentFailure } from "@/lib/moderation/extraction-hits";
import { captureAndBroadcast, voidAndFlush, sweepAndFlush } from "@/lib/payments/settle";
import { solanaChainKey } from "@/lib/payments/solana";
import type { VoidReason } from "@/lib/payments/authorization";
import { reportSuccess, reportFailure } from "@/lib/generation/provider-health";
import { childSafetyScore, recordModerationEvent } from "@/lib/moderation-enforcement";
import { recordGeneration, resolveRecordingUserId, recordGenerationFailure, type GenerationFailure } from "@/lib/generation/record";
import { storeReferenceImages } from "@/lib/generation/reference-images";
import { INLINE_MAX_BYTES, putDurably, storeDeadline } from "@/lib/generation/derivative-store";
import { acquireSlot, releaseSlot } from "@/lib/generation/concurrency";
import { stripWorkflowImages } from "@/lib/generation/workflow";
import {
  fulfillGenerationIntent,
  releaseGenerationIntent,
} from "@/lib/payments/generation-redemption";

// Above the 90s provider timeout: the in-process timeout (and the intent
// release it triggers) must fire BEFORE the platform kills the function,
// otherwise a paid, consumed intent is stranded with no release.
// WaveSpeed's nano-banana-pro measured 73-78s and AceData's gpt-image-2 at
// 3840x2160 took 63s — both inside 120s, but with no room for a retry or a
// slow day, and the failure lands AFTER the buyer has authorised payment.
export const maxDuration = 300;

// Five budgets that MUST stay in this order, or a generation that is still
// running gets treated as dead by something downstream:
//
//   285s  this timeout      give up in-process, with time left to upload,
//                           record and answer inside the platform budget
//   285s  storeDeadline     (lib/generation/derivative-store.ts) counted from
//                           the request, not the provider call: the stored
//                           image must have landed, or nothing is captured
//   300s  maxDuration       the platform kills the function here
//   330s  SLOT_TTL_MS       (lib/generation/concurrency.ts) a killed function
//                           must not free its slot before it is truly gone
//   360s  STALE_CLAIM_MS    (lib/payments/generation-redemption.ts) a claim is
//                           only "provably dead" once every step above is
//
// Raising maxDuration alone inverts it: at 300s the slot expires at 150s and
// the claim is released at 180s while the generation is still legitimately
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
  /** An authorised generation_payment_intents row. Every generation here needs one. */
  intentId?: string;
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
  // Set after a successful intent redemption (client captured then, so this
  // helper can never throw); every generation-failure path — including the
  // catch-all below — must release it so the buyer retries without paying
  // again.
  let consumedIntent: { supabase: SupabaseClient; id: string; mode: ClaimMode } | null = null;
  // What a failure from the concurrency cap on is recorded with, for the admin person list.
  let failCtx: Omit<GenerationFailure, "error"> | null = null;
  /**
   * Give the payment back. What that MEANS depends on the model, and the two
   * are not interchangeable:
   *
   *   prepaid     the transfer already settled, so all we can return is the
   *               claim — the buyer keeps a usable intent and retries.
   *   authorized  nothing has moved. Void it and close the nonce, which kills
   *               the held signature for good. Returning the claim instead
   *               would leave a live signature on a generation we gave up on.
   */
  const releaseIfConsumed = async (reason: VoidReason = "provider_failed") => {
    if (!consumedIntent) return;
    const held = consumedIntent;
    consumedIntent = null;
    if (held.mode === "authorized") {
      await voidAndFlush(held.supabase, held.id, reason).catch((e) =>
        console.error("[generate] void failed:", held.id, e instanceof Error ? e.message : e),
      );
    } else {
      await releaseGenerationIntent(held.supabase, held.id);
    }
  };

  // Flush authorisations whose worker went quiet. Opportunistic because this
  // deployment has no scheduler: every generation sweeps a few on its way in,
  // so under load it runs constantly, and with no load there is also nobody
  // whose held signature could be misused. after() so a slow sweep never
  // delays a paying customer, and sweepAndFlush never throws.
  after(sweepAndFlush(getSupabaseServerClient()));

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
        { error: `resolution must be one of 1K, 2K, 4K (received ${JSON.stringify(body.resolution)})` },
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
     * GPT-Image-2 purchase and voided its authorisation.
     *
     * Read before the preflight on purpose: this same object decides the
     * routing, the reference-image eligibility and the quote below, so
     * learning the family after those were settled would only have let us
     * complain about them rather than get them right. The read is by intent id
     * alone — it selects which model to OFFER, and claimForGeneration binds to
     * the buyer's wallet before anything is consumed, so a stolen id buys a
     * wasted preflight and nothing else. */
    const intentId = typeof body.intentId === "string" ? body.intentId.trim() : "";
    // Intents only (REC-4): the legacy X-PAYMENT rail paid first and generated
    // second, so a failed generation kept the money. Free models have their
    // own route, /api/generate-free.
    if (!intentId) {
      return NextResponse.json(
        { error: "A paid generation needs a payment intent. Nothing was generated and nothing was charged." },
        { status: 402 },
      );
    }
    if (!UUID_RE.test(intentId)) {
      return NextResponse.json({ error: "intentId must be a UUID" }, { status: 400 });
    }

    /* The intent is the sum of settings the buyer paid for (REC-4): the exact
       model row, the resolution, the quality that runs, boost and how many
       reference images. Everything below runs those and nothing the request
       body says instead. */
    const { data: intentRow } = await (getSupabaseServerClientSafe()
      ?.from("generation_payment_intents")
      .select("model_id, model_family, resolution, quality, boost, reference_image_count, prompt_id, artist_amount_micro")
      .eq("id", intentId)
      .maybeSingle() ?? Promise.resolve({ data: null }));
    const paid = intentRow as
      | (StoredSettings & { model_family: string; prompt_id: string | null; artist_amount_micro: number })
      | null;
    if (!paid) {
      return NextResponse.json(
        { error: "Payment intent not found. Nothing was generated and nothing was charged." },
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
      if (!text.ok) return NextResponse.json({ error: text.error }, { status: text.status });
      if (overLong(body.variableValues)) {
        return NextResponse.json(
          { error: `Each input can be at most ${VALUE_MAX} characters. Nothing was generated and nothing was charged.` },
          { status: 422 },
        );
      }
      const filled = fillVariables(text.text, body.variableValues, text.variables);
      // A buyer must never pay for an image a value of theirs did not reach.
      if (inputsUnmatched(filled)) {
        return NextResponse.json(
          { error: "This prompt's inputs could not be matched to its text. Nothing was generated and nothing was charged." },
          { status: 422 },
        );
      }
      prompt = filled.text;
      promptAdult = text.adult;
    } else if (paid.prompt_id) {
      const marked = await promptMarkedAdult(getSupabaseServerClient(), paid.prompt_id as string);
      if (marked === null) {
        return NextResponse.json({ error: "This prompt could not be checked right now. Nothing was generated and nothing was charged." }, { status: 503 });
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
    const check = first ? NOT_CHECKED : await checkPrompt(checked, { hidden: fromArtist, signal: request.signal });
    if (check.verdict === "minor_sexual" || check.verdict === "explicit_sexual") {
      const outcome = await recordWarning(getSupabaseServerClient(), {
        surface: "generate-image", request, category: check.verdict, text: authoring ? "" : JSON.stringify(checked), confidence: check.confidence, ...about,
      });
      return NextResponse.json({ error: warningMessage(check.verdict, outcome) }, { status: 422 });
    }
    if (check.verdict === "unavailable") console.warn("[prompt-check] unavailable:", check.reason);
    // Refused silently, but only where a real generation fails: after login,
    // rate limits, slot and claim (below). Answering here, before those,
    // told a caller without a session which inputs were caught.
    const silent = check.verdict !== "clear";

    // 18+ (a suggestive prompt, or a prompt marked 18+) is for confirmed adults
    // only, refused before anything is charged.
    // Whatever else the check found, so the refusal never depends on it.
    const adult = ("adult" in check && check.adult === true) || promptAdult;
    const asker = adult ? await resolveRecordingUserId(getSupabaseServerClient(), request) : null;
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

    const paidTier = normalizeTier(paid.resolution);
    const paidModel = paid.model_id ? await resolveModel(getSupabaseServerClientSafe(), [paid.model_id]) : null;
    if (!paidTier || !paidModel || toModelFamily(paidModel.name) !== paid.model_family) {
      // The row it paid for is gone or changed family. Generating on anything
      // else would be the exact substitution this path exists to prevent.
      return NextResponse.json(
        { error: `This payment is for ${paid.model_family}, which is not available right now. Nothing was generated and nothing was charged.` },
        { status: 409 },
      );
    }
    // A setting the request repeats must agree with the payment, refused here
    // before the slot and the claim, so there is nothing to void.
    const attachedRefs = referenceImageCount(body.referenceImages);
    const mismatch = settingMismatch(
      paid,
      { modelIds: body.modelIds, resolution: askedResolution, quality: body.quality, boost: body.boost, referenceImageCount: attachedRefs },
      paidModel.supportsQuality,
    );
    if (mismatch) {
      return NextResponse.json(
        { error: `This payment does not cover the requested ${mismatch}. Nothing was generated and nothing was charged.` },
        { status: 400 },
      );
    }
    // Never sliced away below: a reference the model cannot take is refused.
    if (attachedRefs > paidModel.maxRefs) {
      return NextResponse.json(
        { error: `${paidModel.name} takes at most ${paidModel.maxRefs} reference images. Nothing was generated and nothing was charged.` },
        { status: 422 },
      );
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
            `Nothing was generated and nothing was charged. ` +
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
        { error: `${preflightModel.name} has no provider model configured. Nothing was generated and nothing was charged.` },
        { status: 503 },
      );
    }

    // 3c. Concurrency cap — before any payment step, so a refused request is
    // never a charged one. Unlimited unless an admin sets a number.
    const slotSupabase = getSupabaseServerClientSafe();
    const slotUserId = await resolveRecordingUserId(slotSupabase, request);
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

    // 4. Rate limiting (Placeholder)
    // TODO: Implement rate limiting (e.g., using @upstash/ratelimit or express-rate-limit)
    // max 10 generations per user per minute
    // --- END SECURITY GUARDS ---

    const enhancedPrompt = prompt;

    // --- Redeem the authorised intent ---
    // Identity comes from the session (the intent is bound to its buyer),
    // the paid resolution comes from the intent row — neither is taken
    // from the request. Redemption is a one-shot conditional UPDATE, so a
    // replayed intentId can never buy a second generation.
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
    } catch {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    if (!checkRateLimit(authUser.userId, "generate:intent", 60, 60_000)) {
      return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    }
    const supabase = getSupabaseServerClient();
    // One claim function for both payment models. Two independent claim
    // paths against one row is how a double charge happens: each correct on
    // its own, together broadcasting a held transaction for funds that had
    // already settled. It refuses an intent carrying the markers of both
    // rather than guessing which.
    const redemption = await claimForGeneration(supabase, {
      intentId,
      buyerWallet: authUser.userId,
    });
    if (!redemption.ok) {
      return NextResponse.json({ error: redemption.error }, { status: redemption.status });
    }
    consumedIntent = { supabase, id: intentId, mode: redemption.mode };

    /* The buyer must receive the model they paid for.
     *
     * model_family is written onto the intent when the quote is taken and
     * priced from it — nano-banana-pro and gpt-image-2 are $0.134 and $0.167
     * at 2K, and $0.24 and $0.25 at 4K. Which model actually RUNS comes from
     * body.modelIds via resolveModel() above, a completely separate input
     * that nothing compared to the intent. `modelFamily` appeared exactly
     * once in this file, as a field on the metadata literal below, and was
     * never read again.
     *
     * So quoting the cheap family and then sending the expensive one in
     * modelIds cost the difference on every generation, and the reverse —
     * paying for the dear one and being served the cheap one — was equally
     * silent. Both end here: the intent decides, and a mismatch is refused
     * before anything is generated, with the intent released so the buyer
     * can retry rather than losing the payment. */
    /* Belt and braces. preflightModel was SELECTED from the intent's family
       above, so this can only fire if the two reads disagreed — a row
       changing under us between them. Cheap, and the failure it guards
       against is a buyer receiving a model they did not buy. */
    const runningFamily = toModelFamily(preflightModel.name);
    if (redemption.modelFamily && runningFamily !== redemption.modelFamily) {
      console.warn(
        "[generate] model family mismatch:",
        { intentId, paidFor: redemption.modelFamily, wouldRun: runningFamily },
      );
      /* releaseIfConsumed, not a hand-rolled undo: it already knows that an
         AUTHORIZED intent must be voided rather than released — returning
         the claim would leave a live signature on a generation we refused.
         "rejected" is the reason that fits; the provider never failed, we
         declined to run. */
      await releaseIfConsumed("rejected");
      return NextResponse.json(
        {
          error: `This payment is for ${redemption.modelFamily}, but the request would generate with ${runningFamily}.`,
        },
        { status: 400 },
      );
    }
    const paymentMetadata = {
      paymentIntentId: intentId,
      modelFamily: redemption.modelFamily,
      resolution: redemption.resolution,
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
      await releaseIfConsumed();
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
      SOLANA_GENERATION_TIMEOUT_MS,
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
      await releaseIfConsumed();
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
      await releaseIfConsumed();
      await releaseHeldSlot();
      return NextResponse.json(SILENT_FAILURE, { status: 500 });
    }

    // Stored until it lands (putDurably). Inline only when no store answers by
    // the deadline AND the bytes fit the response cap: a bigger one used to go
    // inline anyway, was captured, and reached the buyer as HTTP 413 with no
    // image. When neither works, nothing is charged.
    const imageUrl =
      (await putDurably(
        `generations/${Date.now()}_${Math.random().toString(36).substring(2, 9)}.png`,
        generatedImageBuffer,
        "image/png",
        storeDeadline(startedAt),
      )) ??
      (generatedImageBuffer.length <= INLINE_MAX_BYTES
        ? `data:image/png;base64,${generatedImageBuffer.toString("base64")}`
        : null);
    // Past the deadline even an inline image is refused: the capture after it
    // would run into the platform's kill with the buyer's money moving.
    if (!imageUrl || Date.now() > storeDeadline(startedAt)) {
      if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: "image could not be stored" }));
      await releaseIfConsumed();
      await releaseHeldSlot();
      return NextResponse.json(
        { error: "Your image was made but could not be delivered. Nothing was charged. Please try again." },
        { status: 503 },
      );
    }

    // The image exists and is stored. NOW take the money.
    //
    // This order is the whole promise: "once the image goes through, we will
    // receive the money. otherwise it will be sent back" (Kev, 2026-08-06),
    // written into Terms of Use Section 4. Capturing before the image was
    // durably stored would charge for something an upload failure could still
    // lose; capturing after means the only thing a crash in between costs us
    // is our own fee, and that is the direction that must fail.
    //
    // For a prepaid intent there is nothing to capture — the transfer settled
    // before the generation started — so this marks it delivered and stops.
    if (consumedIntent) {
      const settled = consumedIntent;
      if (settled.mode === "authorized") {
        const captured = await captureAndBroadcast(settled.supabase, settled.id);
        if (!captured) {
          // The claim was lost (swept as abandoned) or the broadcast failed.
          // Either way the buyer keeps the image: a durable-nonce transaction
          // does not expire, so a failed broadcast stays rebroadcastable, and
          // only we can invalidate that nonce.
          console.error("[generate] delivered but not captured:", settled.id);
        }
      }
      // Marks the intent delivered so the stale-claim rescue can never mistake
      // it for a dead claim and hand out a second image.
      await fulfillGenerationIntent(settled.supabase, settled.id);
      consumedIntent = null;
    }

    // Write the generation down. after() rather than await: the record must
    // not delay the image the user is waiting on, and a floating promise can be
    // frozen with the lambda before the insert lands.
    //
    // Nothing recorded a generation before this — POST /api/generations wrote
    // columns that do not exist and its callers swallowed the failure, so every
    // generation vanished when the tab closed.
    {
      const recSupabase = getSupabaseServerClientSafe();
      const recUserId = await resolveRecordingUserId(recSupabase, request);
      if (recSupabase && recUserId) {
        // The Grok branch returns a metadata object with only `model`, so read
        // the measured fields defensively rather than assuming the Gemini shape.
        const m = geminiResult.metadata as {
          resolution?: string | null;
          bytes?: number | null;
          format?: string | null;
        } | undefined;
        const dims = m?.resolution?.split("x") ?? [];
        // Bytes out of the graph before it is stored: the editor embeds
        // references as data URLs, and its own draft save already breaks on
        // the 5MB cap because of it.
        const stripped = stripWorkflowImages(body.workflow ?? {});
        // The reference uploads run in after() too: an upload stuck on a
        // failing store must not hold the answer to a buyer who has paid.
        after(async () =>
          recordGeneration(recSupabase, {
            adult,
            userId: recUserId,
            promptId: paid.prompt_id ?? null,
            finalPrompt: prompt,
            // What actually reached the model, not what the user typed: the
            // rewrite runs at temperature 0.7, so replaying the original
            // produces a different request every time.
            effectivePrompt: enhancedPrompt,
            variableValues: body.variableValues ?? {},
            model: preflightModel,
            route: preflightRoute,
            boost: paid.boost,
            aspectRatio: body.aspectRatio || body.ratio || null,
            resolution: paidTier,
            // Only Pollinations exposes one, and it currently discards it.
            seed: null,
            output:
              dims.length === 2 && m?.bytes
                ? {
                    width: Number(dims[0]) || 0,
                    height: Number(dims[1]) || 0,
                    bytes: m.bytes,
                    format: m.format ?? '',
                  }
                : null,
            imageUrl,
            generationMs: geminiResult.generationTime ?? null,
            workflow: stripped.workflow,
            workflowTexts: stripped.texts,
            // Uploaded once and referenced, rather than inlined into the
            // workflow blob: the same reference across twenty generations is
            // one object and twenty rows, not twenty copies of the base64.
            references: await storeReferenceImages(
              stripped.images.length ? stripped.images : (body.referenceImages ?? []),
              recUserId,
            ),
            chainKey: solanaChainKey(),
          }),
        );
      }
    }

    await releaseHeldSlot();

    // Return image with payment metadata and headers
    return NextResponse.json(
      {
        imageUrl,
        prompt: fromArtist ? undefined : enhancedPrompt,
        provider: preflightRoute.provider,
        model: geminiResult.metadata?.model || preflightRoute.providerModel,
        generationTime: geminiResult.generationTime,
        paymentScheme: 'intent',
        metadata: {
          ...paymentMetadata,
          geminiMetadata: geminiResult.metadata,
        },
      },
      { status: 200 },
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("Generate image error:", message);
    if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: message }));
    await releaseIfConsumed();
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
