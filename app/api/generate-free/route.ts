import { NextRequest, NextResponse, after } from "next/server";
import { generateImageWithPollinations } from "@/backend/services/pollinations-image-generation";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { moderate, screenFirst, CLIENT_BLOCK_MESSAGE } from "@/lib/moderation";
import { recordModerationEvent } from "@/lib/moderation-enforcement";
import { checkPrompt, NOT_CHECKED } from "@/lib/moderation/prompt-check";
import { recordWarning, warningMessage } from "@/lib/moderation/warnings";
import { ADULT_REFUSAL, adultConfirmed, promptMarkedAdult } from "@/lib/adult-content";
import { SILENT_FAILURE, silentFailure } from "@/lib/moderation/extraction-hits";
import { getSupabaseServerClientSafe } from "@/lib/supabaseServer";
import { recordGeneration, resolveRecordingUserId, recordGenerationFailure, type GenerationFailure } from "@/lib/generation/record";
import { resolveModel } from "@/lib/generation/models";
import { normalizeTier, RESOLUTION_TIERS } from "@/lib/generation/resolution";
import { stripWorkflowImages } from "@/lib/generation/workflow";
import { storeReferenceImages } from "@/lib/generation/reference-images";
import { readImageDimensions } from "@/backend/services/gemini-image-generation";
import { freeGenerationDecision } from "@/lib/generation/free-quota";

// A silent refusal waits 3-12 s like a failing generation; a platform default
// of 10-15 s would turn the slow ones into timeouts, which is a tell of its own.
export const maxDuration = 300;

/**
 * Free image generation endpoint (dev/testing)
 *
 * Uses Pollinations.ai (free, no API key needed)
 * No payment required, no database needed.
 *
 * REQUIRES A SESSION as of 2026-08-18. It used to be deliberately
 * unauthenticated, which made the per-account free allowance decorative: the
 * way around three-per-account was to log out, because an anonymous caller has
 * no user_id for an allowance to count against and an IP is neither stable nor
 * personal. Free generation is now: team roles without a limit, every other
 * account three images, nobody else.
 *
 * The other guards stay exactly as they were — the same moderation the paid
 * path gets, a per-IP rate limit, and violations attributed by hashed IP.
 *
 * POST /api/generate-free
 * Body: { prompt, aspectRatio?, resolution?, workflow? }
 * Reference images are refused here — the free model is text-only.
 */
/** Only a real uuid may reach generations.prompt_id — it is a foreign key. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  // What a failure from the render on is recorded with, for the admin person list.
  let failCtx: Omit<GenerationFailure, "error"> | null = null;
  // JSON only. A page elsewhere may send a form or plain text here in a
  // visitor's name without asking first; every request costs a check and can
  // earn the visitor's address a warning. JSON from another site has to ask,
  // and is refused.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Send the request as JSON." }, { status: 415 });
  }
  try {
    const body = await request.json();
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";

    if (!prompt) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }
    if (prompt.length > 4000) {
      return NextResponse.json({ error: "Prompt too long" }, { status: 400 });
    }

    // Reference images cannot work here and must not look as if they do.
    //
    // The free path is Pollinations, which is text-to-image only — there is no
    // image input to give them to. The editor was posting them anyway and this
    // route was reading nothing: a user attached fourteen references, watched a
    // generation succeed, and got a picture that had never seen one of them.
    // Say so instead.
    if (Array.isArray(body?.referenceImages) && body.referenceImages.some(Boolean)) {
      return NextResponse.json(
        { error: "Reference images need a paid generation — the free model is text-only." },
        { status: 422 },
      );
    }

    // Per IP: it runs before the account is known.
    const limit = checkRequestRateLimit(rateLimitKey(request, "generate-free"), 10, 60_000);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    /* The selected model, and only if it is the free one. This route used to
       read no model at all and render Flux for whatever the caller picked, so
       every client that guessed "free" from a price or a prompt type handed a
       Nano Banana Pro pick a Flux picture (Kev, 2026-10-02: "es darf NIEMALS
       IRGENDEIN standardmodell durchgeschickt werden sondern IMMER DAS
       AUSGEWÄHLTE"). */
    const model = UUID_RE.test(String(body?.modelId ?? ""))
      ? await resolveModel(getSupabaseServerClientSafe(), [String(body.modelId)])
      : null;
    if (!model) {
      return NextResponse.json(
        { error: "The chosen model is unknown or not available right now. Nothing was generated." },
        { status: 422 },
      );
    }
    if (model.normal.provider !== "pollinations") {
      return NextResponse.json(
        { error: `${model.name} is a paid model and needs a payment. Nothing was generated and nothing was charged.` },
        { status: 402 },
      );
    }
    const resolution = body.resolution == null ? model.maxResolution : normalizeTier(body.resolution);
    if (!resolution || RESOLUTION_TIERS.indexOf(resolution) > RESOLUTION_TIERS.indexOf(model.maxResolution)) {
      return NextResponse.json(
        { error: `${model.name} renders up to ${model.maxResolution}. Nothing was generated.` },
        { status: 422 },
      );
    }
    if (body.boost === true) {
      return NextResponse.json({ error: `${model.name} has no boost. Nothing was generated.` }, { status: 422 });
    }

    // The free generator renders whatever it is given and filters nothing
    // itself, so the prompt is judged here first, like every paid one. Only
    // an account generates here, and an account is stopped by its own ban:
    // the address ladder would only have silenced every other account on a
    // shared address (an office, a mobile network) for one stranger's warnings.
    const supabaseForChecks = getSupabaseServerClientSafe();
    if (!supabaseForChecks) return NextResponse.json(SILENT_FAILURE, { status: 500 });
    // An artist's draft from an editor: no moderator may read it, marked as
    // withheld on the requester's word (lib/moderation/evidence). Any session
    // token counts, live, expired or suspended: a draft must never be shown.
    // Text withheld by a stranger's made-up token stays labelled as theirs and
    // counts on the ladder as before; the owner opens it where it is a
    // warning or a child-safety case, and other blocks stay closed.
    const authoring = body?.authoring === true && Boolean(request.headers.get("X-Session-Token"));
    // The regex first: what Tier 1 refuses never reaches the chat model, and
    // its refusal is this request's moderation verdict (Kev, 2026-10-06).
    const first = screenFirst({ prompt });
    const check = first ? NOT_CHECKED : await checkPrompt({ prompt }, { hidden: false, signal: request.signal });
    if (check.verdict === "minor_sexual" || check.verdict === "explicit_sexual") {
      const outcome = await recordWarning(supabaseForChecks, {
        surface: "generate-free", request, category: check.verdict, confidence: check.confidence,
        ...(authoring ? { text: "", withheld: prompt, draft: true } : { text: prompt }),
      });
      return NextResponse.json({ error: warningMessage(check.verdict, outcome) }, { status: 422 });
    }
    if (check.verdict === "unavailable") console.warn("[prompt-check] unavailable:", check.reason);
    // Refused silently only where a real generation fails, after the sign-in
    // and quota answers below; earlier, a signed-out caller could tell.
    const silent = check.verdict !== "clear";
    // 18+ (a suggestive prompt, or a prompt marked 18+) is for confirmed adults
    // only; an anonymous visitor cannot confirm.
    const marked = await promptMarkedAdult(supabaseForChecks, UUID_RE.test(String(body?.promptId ?? "")) ? String(body.promptId) : null);
    if (marked === null) {
      return NextResponse.json({ error: "This prompt could not be checked right now. Nothing was generated." }, { status: 503 });
    }
    const adult = (check.verdict === "clear" && check.adult === true) || marked;
    if (adult && !(await adultConfirmed(supabaseForChecks, await resolveRecordingUserId(supabaseForChecks, request)))) {
      return NextResponse.json(ADULT_REFUSAL, { status: 403 });
    }

    const verdict = first ?? await moderate({ prompt, surface: "generate-free", signal: request.signal, adultJudged: true });
    after(recordModerationEvent(verdict, { surface: "generate-free", request, ...(authoring ? { prompt: "", withheld: prompt, draft: true } : { prompt }) }));
    if (!verdict.allowed) {
      return NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 });
    }

    /* The free allowance, checked BEFORE the provider is called.
     *
     * Three images per account (Kev, 2026-08-18) — free usage is an onboarding
     * allowance for new accounts, not a permanent tier. Checked here rather
     * than after generating so an account over its limit does not cost a
     * render, and so the answer arrives in a second rather than a minute.
     *
     * A caller without an account is asked to sign in here: only accounts
     * generate on this route, and an account is stopped by its own ban.
     */
    const quotaClient = getSupabaseServerClientSafe();
    const quotaUserId = await resolveRecordingUserId(quotaClient, request);
    if (quotaClient) {
      const decision = await freeGenerationDecision(quotaClient, quotaUserId);
      if (!decision.allowed && decision.reason === "sign-in") {
        return NextResponse.json(
          {
            error: "Sign in to generate for free.",
            signInRequired: true,
          },
          { status: 401 },
        );
      }
      if (!decision.allowed) {
        const q = decision.quota;
        return NextResponse.json(
          {
            error: `You have used all ${q?.limit ?? 0} free generations on this account.`,
            freeQuotaExhausted: true,
            used: q?.used ?? 0,
            limit: q?.limit ?? 0,
          },
          { status: 402 },
        );
      }
    }

    // Never log the prompt itself — this is shared log output, and a blocked
    // prompt is exactly the text we must not spray around in the clear.
    console.log('🎨 Free generation request:', {
      chars: prompt.length,
      aspectRatio: body.aspectRatio || '1:1',
      resolution,
    });

    if (silent) return silentFailure();

    failCtx = {
      request, surface: "generate-free", modelId: model.id, resolution, quality: null, boost: false,
      aspectRatio: body.aspectRatio || "1:1", referenceImageCount: 0, prompt: authoring ? null : prompt,
    };
    const result = await generateImageWithPollinations(
      prompt,
      body.aspectRatio || '1:1',
      resolution,
      model.normal.providerModel,
    );

    if (!result.success || !result.imageBuffers || result.imageBuffers.length === 0) {
      console.error('❌ Image generation failed:', result.error);
      after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: result.error || "Image generation failed" }));
      // Same answer as a caught request, so the two cannot be told apart.
      return NextResponse.json(SILENT_FAILURE, { status: 500 });
    }

    // Convert to base64 data URL (no blob storage needed).
    //
    // The media type is MEASURED from the bytes, not assumed. This said
    // `image/png` unconditionally while Pollinations returns JPEG — verified
    // 2026-08-12 in the browser, the rendered data URL began "/9j/" (FFD8FF,
    // a JPEG SOI). Browsers sniff and display it anyway, which is why nobody
    // noticed; what breaks is everything downstream that believes the label —
    // generated_images.mime_type, download filenames, any CDN or converter.
    const buffer = result.imageBuffers[0];
    const measured = readImageDimensions(buffer);
    const mediaType = measured?.format ? `image/${measured.format}` : 'application/octet-stream';
    const imageUrl = `data:${mediaType};base64,${buffer.toString('base64')}`;

    console.log(`✅ Image generated successfully in ${result.generationTime}ms`);

    // Free does not mean unrecorded. The node editor generates through here,
    // so without this its graphs would be lost exactly like every generation
    // was before the recorder existed. Signed-out callers are not recorded —
    // there is nobody to show the row back to.
    {
      // Same client and same identity the allowance was checked against, so
      // the row that gets written is the row that was counted.
      const supabase = quotaClient;
      const recUserId = quotaUserId;
      if (supabase && recUserId) {
        const stripped = stripWorkflowImages(body?.workflow ?? {});
        // Measured once, above, for the media type. Measuring the same
        // buffer a second time here could only ever agree with itself.
        const dims = measured;
        after(
          recordGeneration(supabase, {
            adult,
            userId: recUserId,
            /* Which prompt this came from.
             *
             * Hardcoded null until 2026-08-13, so every free generation was
             * recorded as if it had come from nowhere — the artist's prompt
             * got no credit for it, and a reader could not later ask "which
             * prompt made this?". The buyer surface now sends the id, and a
             * reader who EDITS the text keeps it: it is still that prompt's
             * descendant, and the edited wording is stored beside it. Shape
             * is checked because this arrives from the client and a bad value
             * would fail the row's foreign key and lose the whole record. */
            promptId: UUID_RE.test(String(body?.promptId ?? "")) ? String(body.promptId) : null,
            finalPrompt: prompt,
            // Pollinations rewrites the prompt itself (`enhance=true`) and
            // never returns the result, so the best we can honestly record is
            // what we sent.
            effectivePrompt: prompt,
            variableValues: {},
            model,
            route: model.normal,
            boost: false,
            aspectRatio: body.aspectRatio || "1:1",
            resolution,
            // The service generates one and throws it away — the only seed in
            // the whole stack, and it never reaches us.
            seed: null,
            output: dims
              ? {
                  width: dims.width,
                  height: dims.height,
                  bytes: result.imageBuffers[0].length,
                  format: dims.format,
                }
              : null,
            generationMs: result.generationTime ?? null,
            workflow: stripped.workflow,
            workflowTexts: stripped.texts,
            references: await storeReferenceImages(stripped.images, recUserId),
          }),
        );
      }
    }

    return NextResponse.json({
      imageUrl,
      prompt,
      provider: "pollinations",
      model: model.normal.providerModel,
      generationTime: result.generationTime,
      free: true,
      /* The size that actually came back, measured from the bytes.
       *
       * The route threw this away while the adapter had already computed it,
       * so nothing downstream could tell a reader what they had received. The
       * free worker clamps on TOTAL pixels before diffusing, so a request and
       * its result routinely disagree — a 2K ask returns 686x858 at 4:5 — and
       * for months the only place that disagreement was visible was a database
       * column nobody reads. requestedResolution travels beside it precisely so
       * the two can be compared rather than conflated.
       */
      width: measured?.width ?? null,
      height: measured?.height ?? null,
      bytes: buffer.length,
      format: measured?.format ?? null,
      requestedResolution: resolution,
    });

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("Generate free image error:", message);
    if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: message }));
    return NextResponse.json(SILENT_FAILURE, { status: 500 });
  }
}
