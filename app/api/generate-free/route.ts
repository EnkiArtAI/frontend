import { NextRequest, NextResponse, after } from "next/server";
import { generateImageWithPollinations } from "@/backend/services/pollinations-image-generation";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { moderate, CLIENT_BLOCK_MESSAGE } from "@/lib/moderation";
import { recordModerationEvent } from "@/lib/moderation-enforcement";
import { checkPrompt } from "@/lib/moderation/prompt-check";
import { addressWarnedOut, recordWarning, warningMessage } from "@/lib/moderation/warnings";
import { SILENT_FAILURE, silentFailure } from "@/lib/moderation/extraction-hits";
import { getSupabaseServerClientSafe } from "@/lib/supabaseServer";
import { recordGeneration, resolveRecordingUserId } from "@/lib/generation/record";
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

    // No session here, so the limit is per IP.
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
    // itself, so the prompt is judged here first, like every paid one. An
    // address without an account that has reached the first step gets no more.
    const supabaseForChecks = getSupabaseServerClientSafe();
    if (!supabaseForChecks) return NextResponse.json(SILENT_FAILURE, { status: 500 });
    // A warned-out address costs no check; it fails silently further down.
    const warnedOut = await addressWarnedOut(supabaseForChecks, request);
    const check = warnedOut ? { verdict: "unavailable" as const, reason: "address warned out" } : await checkPrompt({ prompt }, { hidden: false, signal: request.signal });
    if (check.verdict === "minor_sexual" || check.verdict === "explicit_sexual") {
      const outcome = await recordWarning(supabaseForChecks, {
        surface: "generate-free", request, category: check.verdict, text: prompt, confidence: check.confidence,
      });
      return NextResponse.json({ error: warningMessage(check.verdict, outcome) }, { status: 422 });
    }
    if (check.verdict === "unavailable" && !warnedOut) console.warn("[prompt-check] unavailable:", check.reason);
    // Refused silently only where a real generation fails, after the sign-in
    // and quota answers below; earlier, a signed-out caller could tell.
    const silent = check.verdict !== "clear";

    const verdict = await moderate({ prompt, surface: "generate-free", signal: request.signal });
    after(recordModerationEvent(verdict, { surface: "generate-free", request, prompt }));
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
     * Signed-out callers are deliberately NOT limited here, because they
     * cannot be counted: this route stays unauthenticated, and the only thing
     * standing behind an anonymous caller is the per-IP rate limit above.
     * That is a real gap in the allowance and it is named rather than papered
     * over — closing it means requiring a session, which is a product
     * decision, not a patch.
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

    const result = await generateImageWithPollinations(
      prompt,
      body.aspectRatio || '1:1',
      resolution,
      model.normal.providerModel,
    );

    if (!result.success || !result.imageBuffers || result.imageBuffers.length === 0) {
      console.error('❌ Image generation failed:', result.error);
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
    return NextResponse.json(SILENT_FAILURE, { status: 500 });
  }
}
