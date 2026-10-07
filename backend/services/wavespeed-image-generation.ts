/**
 * WaveSpeed image generation.
 *
 * WaveSpeed hosts the same models Google does — Nano Banana Pro among them —
 * at a lower price and a markedly higher latency. That trade is the product:
 * WaveSpeed is the normal path, and "boost" spends more to go direct.
 *
 * Measured 2026-08-06, same prompt, nano-banana-pro:
 *   WaveSpeed 1K  73.1s   2K  78.1s   4K  77.0s
 *   Gemini    1K  19.2s   2K  28.5s   4K  38.8s
 *
 * ── Why this is not PR #54's version ────────────────────────────────────
 * That one POSTs to /api/v3/predictions with {model_id, input}. The live API
 * rejects it ("page is required; page_size is required") — /predictions is a
 * listing endpoint. The model belongs in the PATH. Verified against the real
 * API before writing this. Its metadata also reported the model as
 * "wavespeed-nano-banana-pro" while actually running flux-dev.
 */
import type { ImageGenerationRequest, ImageGenerationResult } from './types';
import { missingModel } from './model-required';
import { readImageDimensions } from './gemini-image-generation';
import { referenceImageLimit } from '@/lib/generation/provider-capabilities';

/**
 * The image-input sibling of a text-to-image model id.
 *
 * WaveSpeed ids are paths and the trailing segment IS the endpoint:
 * google/nano-banana-pro/text-to-image -> google/nano-banana-pro/edit.
 * An id that already names an image-input endpoint is left alone, so a routing
 * row can point straight at /edit if someone ever configures it that way.
 *
 * Not /edit-multi or /edit-ultra: the first locks num_images to exactly two
 * OUTPUT variants, the second only offers 4k and 8k. /edit is the one that
 * takes many references and returns one image.
 */
export function toEditModel(model: string): string {
  if (/\/(edit|edit-multi|edit-ultra|image-to-image)$/.test(model)) return model;
  // Fast has an edit endpoint of its own: /text-to-image-fast pairs with /edit-fast.
  return model.replace(/\/text-to-image-fast$/, '/edit-fast').replace(/\/text-to-image(-multi|-ultra)?$/, '/edit');
}

const API_BASE = 'https://api.wavespeed.ai/api/v3';

/** Poll cadence. Inference alone runs 60-75s, so a tight loop buys nothing. */
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 240_000;

/**
 * Accepted values, from the API's own rejection messages rather than the docs:
 *   resolution     ["1k", "2k", "4k"]
 *   output_format  ["png", "jpeg"]
 *   aspect_ratio   the same ten Gemini takes
 */
const RESOLUTION_MAP: Record<string, string> = { '1K': '1k', '2K': '2k', '4K': '4k' };

export interface WaveSpeedRequest extends ImageGenerationRequest {
  /**
   * png is WaveSpeed's default and roughly 2.4x the bytes of jpeg for the same
   * image (2K: 6.99 MB vs 3.00 MB). Default to jpeg — a gallery pays for every
   * one of those megabytes on every view.
   */
  outputFormat?: 'png' | 'jpeg';
}

export async function generateImagesWithWaveSpeed(
  request: WaveSpeedRequest,
): Promise<ImageGenerationResult> {
  const startTime = Date.now();
  const requested = request.modelVersion;
  if (!requested) return missingModel(startTime);
  const apiKey = process.env.WAVESPEED_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'WAVESPEED_API_KEY is not set', generationTime: 0, retryable: false };
  }

  /* Reference images switch the ENDPOINT, they are not an extra parameter.
   *
   * WaveSpeed model ids are URL path segments, and the text-to-image variant
   * has no image input at all — which is how references used to vanish here
   * without a word. The sibling that accepts them is /edit, and it takes an
   * `images` array. So the id has to be chosen per request; a single static
   * provider_model string in the routing table cannot express it.
   *
   * The count ceiling is enforced BEFORE the call rather than clamped: sending
   * 15 of 18 attached images would be the silent-loss bug again, just with a
   * smaller loss. Routing normally prevents this from ever being reached by
   * sending an over-large request to a host that can take it.
   */
  const refImages = (request.referenceImages ?? []).filter(
    (r): r is string => typeof r === 'string' && r.trim() !== '',
  );
  const refs = refImages.length;
  const limit = referenceImageLimit('wavespeed');
  if (refs > limit) {
    return {
      success: false,
      error:
        `${refs} reference images were attached, but this host accepts at most ${limit}. ` +
        `Nothing was generated and nothing was charged. Remove ${refs - limit} of them, ` +
        `or choose a model that takes more.`,
      generationTime: Date.now() - startTime,
      retryable: false,
    };
  }

  const model = refs > 0 ? toEditModel(requested) : requested;

  try {
    const input: Record<string, unknown> = {
      prompt: request.prompt,
      output_format: request.outputFormat ?? 'jpeg',
    };
    /* Data URIs go straight in. WaveSpeed documents three accepted forms for
       an image input — a public URL, a base64-encoded data URI, and multipart
       upload — so the browser's own data: URLs need no hosting step of their
       own. (docs: "Accepts public URLs or Base64-encoded Data URLs".) */
    if (refs > 0) input.images = refImages;
    if (request.aspectRatio) input.aspect_ratio = request.aspectRatio;
    /* An unmapped tier is refused, not downgraded. `?? '1k'` sent the
       SMALLEST size for any spelling this map did not know — a lowercase "4k"
       among them — while the caller's price ladder had already charged for the
       largest. Failing the request costs one retry; guessing costs the buyer
       the difference and tells nobody. */
    if (request.imageSize) {
      const mapped = RESOLUTION_MAP[request.imageSize];
      if (!mapped) {
        return {
          success: false,
          error: `Unsupported resolution "${request.imageSize}" — expected one of ${Object.keys(RESOLUTION_MAP).join(', ')}`,
        };
      }
      input.resolution = mapped;
    }
    // Accepted by WaveSpeed's gpt-image-2 with exactly OpenAI's three values —
    // verified live. Models that do not know the field ignore it.
    if (request.quality) input.quality = request.quality;

    const submit = await fetch(`${API_BASE}/${model}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(input),
    });

    if (!submit.ok) {
      const body = await submit.text().catch(() => '');
      // Credit exhaustion also arrives as a 400, and it is not retryable —
      // hammering it just burns the caller's time.
      const outOfCredit = /insufficient credits/i.test(body);
      return {
        success: false,
        error: outOfCredit ? 'WaveSpeed account is out of credits' : `WaveSpeed rejected the request (${submit.status}): ${body.slice(0, 300)}`,
        generationTime: Date.now() - startTime,
        retryable: !outOfCredit && submit.status >= 500,
      };
    }

    const submitted = await submit.json();
    const id = submitted?.data?.id ?? submitted?.id;
    if (!id) {
      return { success: false, error: 'WaveSpeed returned no prediction id', generationTime: Date.now() - startTime, retryable: true };
    }

    const deadline = Date.now() + MAX_POLL_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      let status: any;
      try {
        const res = await fetch(`${API_BASE}/predictions/${id}/result`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) continue;
        status = (await res.json())?.data ?? {};
      } catch {
        // A dropped connection mid-poll is common on a 70s job and says
        // nothing about the prediction — keep waiting.
        continue;
      }

      /* WaveSpeed documents SIX statuses — created, processing, completed,
       * failed, cancelled, timeout — and only the first two mean "keep
       * waiting". Treating just `failed` as terminal left `cancelled` and
       * `timeout` falling through to the poll loop, which then spun for the
       * full 240s before reporting a timeout of our own. The buyer waited
       * four minutes to be told the wrong reason for a job that was already
       * over. Not retryable: the provider ended it deliberately, and hammering
       * it would charge the breaker for a fault it did not commit. */
      if (status.status === 'failed') {
        return { success: false, error: status.error || 'WaveSpeed generation failed', generationTime: Date.now() - startTime, retryable: true };
      }
      if (status.status === 'cancelled' || status.status === 'timeout') {
        return {
          success: false,
          error: status.error || `WaveSpeed ${status.status} the generation`,
          generationTime: Date.now() - startTime,
          retryable: false,
        };
      }
      if (status.status !== 'completed') continue;

      const url = status.outputs?.[0];
      if (!url) {
        return { success: false, error: 'WaveSpeed completed without an output', generationTime: Date.now() - startTime, retryable: true };
      }

      const img = await fetch(url);
      if (!img.ok) {
        return { success: false, error: `Could not download the WaveSpeed image (${img.status})`, generationTime: Date.now() - startTime, retryable: true };
      }
      const buffer = Buffer.from(await img.arrayBuffer());
      const measured = readImageDimensions(buffer);

      return {
        success: true,
        imageBuffers: [buffer],
        generationTime: Date.now() - startTime,
        metadata: {
          // The model that actually ran, not a label. PR #54 recorded
          // "wavespeed-nano-banana-pro" while running flux-dev.
          model,
          aspectRatio: request.aspectRatio || '1:1',
          resolution: measured ? `${measured.width}x${measured.height}` : null,
          requestedSize: request.imageSize ?? null,
          bytes: buffer.length,
          format: measured?.format ?? null,
        },
      };
    }

    return { success: false, error: 'WaveSpeed timed out', generationTime: Date.now() - startTime, retryable: true };
  } catch (error: any) {
    return {
      success: false,
      error: `WaveSpeed error: ${error?.message ?? 'unknown'}`,
      generationTime: Date.now() - startTime,
      retryable: true,
    };
  }
}
