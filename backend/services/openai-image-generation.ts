/**
 * OpenAI image generation (gpt-image-2).
 *
 * The odd one out: Gemini and WaveSpeed take an aspect RATIO, OpenAI takes
 * PIXELS as "WIDTHxHEIGHT". So the ratio and the quality tier have to be
 * turned into a concrete size that satisfies the model's constraints, which
 * are strict and stated in the docs:
 *
 *   both edges divisible by 16
 *   long edge / short edge no more than 3:1
 *   max edge 3840
 *   total pixels between 655,360 and 8,294,400
 *
 * Getting that arithmetic wrong is a 400 AFTER the payment settles, which is
 * the failure mode this codebase keeps producing — so the size is computed and
 * then clamped, never assumed.
 *
 * `quality` is the real price lever here, not the size: at 1024x1024 OpenAI
 * charges roughly $0.006 low, $0.053 medium, $0.211 high — a 35x spread. It
 * maps from our 1K/2K/4K tier, which is the only quality control the UI has.
 */
import type { ImageGenerationRequest, ImageGenerationResult } from './types';
import { missingModel } from './model-required';
import { readImageDimensions } from './gemini-image-generation';
import { referenceImageLimit } from '@/lib/generation/provider-capabilities';
import { normalizeTier } from '@/lib/generation/resolution';

const ENDPOINT = 'https://api.openai.com/v1/images/generations';
/** Reference images go here instead — multipart, one `image[]` part each. */
const EDIT_ENDPOINT = 'https://api.openai.com/v1/images/edits';

/**
 * A data URI or bare base64 payload as bytes plus its media type.
 *
 * Returns null rather than guessing. A reference we cannot decode must fail
 * the request, not be quietly left out: dropping one of five attachments and
 * charging for all five is the exact failure this whole layer exists to stop.
 */
function decodeImageInput(input: string): { bytes: ArrayBuffer; mime: string } | null {
  // [\s\S] rather than the dotAll flag: the build target predates es2018 and
  // an `s` flag fails compilation. This exact trap has bitten this repo before.
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(input.trim());
  const mime = m ? m[1] : 'image/png';
  const payload = m ? m[2] : input.trim();
  if (!payload) return null;
  try {
    const buf = Buffer.from(payload, 'base64');
    if (buf.length === 0) return null;
    return {
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      mime,
    };
  } catch {
    return null;
  }
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
};

/** The multipart body for /v1/images/edits. */
function buildEditForm(args: {
  model: string;
  prompt: string;
  size: string;
  quality: string;
  refImages: string[];
}): FormData {
  const form = new FormData();
  form.append('model', args.model);
  form.append('prompt', args.prompt);
  form.append('size', args.size);
  form.append('quality', args.quality);
  form.append('n', '1');
  args.refImages.forEach((ref, i) => {
    const decoded = decodeImageInput(ref);
    if (!decoded) throw new UnreadableReferenceError(i + 1);
    // A filename is supplied because the official client always sends one; the
    // extension follows the measured media type rather than a fixed guess.
    const ext = EXT[decoded.mime.toLowerCase()] ?? 'png';
    form.append('image[]', new Blob([decoded.bytes], { type: decoded.mime }), `reference-${i + 1}.${ext}`);
  });
  return form;
}

class UnreadableReferenceError extends Error {
  constructor(readonly position: number) {
    super(`Reference image ${position} could not be read`);
    this.name = 'UnreadableReferenceError';
  }
}

/** Hard limits from the API docs. Verified against them, not guessed. */
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const MAX_EDGE = 3840;

const STEP = 16;

/** Target pixel counts per tier, inside the allowed band. */
const TIER_PIXELS: Record<string, number> = {
  '1K': 1_100_000,
  '2K': 4_200_000,
  '4K': MAX_PIXELS,
};

/** low | medium | high — the price lever, mapped from our tier. */
const TIER_QUALITY: Record<string, 'low' | 'medium' | 'high'> = {
  '1K': 'low',
  '2K': 'medium',
  '4K': 'high',
};

function parseRatio(ratio: string | undefined): number {
  const m = (ratio ?? '1:1').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!m) return 1;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return 1;
  // The model refuses anything beyond 3:1 either way, so clamp rather than
  // send a request we already know will be rejected.
  return Math.min(3, Math.max(1 / 3, w / h));
}

const roundTo = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);

/**
 * Ratio + tier -> a size the model will accept. Exported for tests: the
 * arithmetic is the part that fails expensively.
 */
export function sizeFor(ratio: string | undefined, tier: string | undefined): string {
  const r = parseRatio(ratio);
  /* Case is repaired, not defaulted. An unrecognised tier used to fall to the
     2K target — 4,200,000 px against 4K's 8,294,400 — so a "4k" request came
     back at roughly half the pixels it was charged for, with no error. An
     absent tier is still 2K, which is the documented default; a PRESENT but
     unreadable one is a bug in the caller and must not be smoothed over. */
  const norm = tier == null ? '2K' : normalizeTier(tier);
  if (!norm) throw new Error(`Unsupported resolution tier "${tier}" — expected 1K, 2K or 4K`);
  let target = TIER_PIXELS[norm];

  const build = (pixels: number) => {
    const h = Math.sqrt(pixels / r);
    return { w: roundTo(h * r, STEP), h: roundTo(h, STEP) };
  };

  let { w, h } = build(target);

  // Long edge first: shrinking for the edge cap can drop us under the pixel
  // floor, so the floor is enforced afterwards and not before.
  const longest = Math.max(w, h);
  if (longest > MAX_EDGE) {
    const scale = MAX_EDGE / longest;
    w = roundTo(w * scale, STEP);
    h = roundTo(h * scale, STEP);
  }

  while (w * h > MAX_PIXELS) {
    target *= 0.95;
    ({ w, h } = build(target));
  }
  while (w * h < MIN_PIXELS) {
    target *= 1.05;
    ({ w, h } = build(target));
    if (Math.max(w, h) > MAX_EDGE) break;
  }

  return `${w}x${h}`;
}

export async function generateImagesWithOpenAI(
  request: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  const startTime = Date.now();
  const model = request.modelVersion;
  if (!model) return missingModel(startTime);
  const apiKey = (process.env.OPENAI_API_KEYS || process.env.OPENAI_API_KEY || '')
    .split(',')[0]
    ?.trim();
  if (!apiKey) {
    return { success: false, error: 'OPENAI_API_KEY is not set', generationTime: 0, retryable: false };
  }

  /* Reference images change the ENDPOINT and the encoding.
   *
   * /v1/images/generations has no image input at all — which is how references
   * used to vanish here. /v1/images/edits takes them, as repeated multipart
   * `image[]` file parts rather than JSON. So a request with references is a
   * different call, not the same call with an extra field.
   *
   * The ceiling is enforced, not clamped: sending 17 of 18 attached images
   * would be the silent-loss bug again with a smaller loss. Routing normally
   * keeps an over-large request away from this host in the first place. */
  const refImages = (request.referenceImages ?? []).filter(
    (r): r is string => typeof r === 'string' && r.trim() !== '',
  );
  const refs = refImages.length;
  const limit = referenceImageLimit('openai');
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

  const size = sizeFor(request.aspectRatio, request.imageSize);
  // The user's choice wins. Deriving it from the resolution tier was a guess:
  // size and quality are separate parameters here, and quality is the one that
  // moves the price by a factor of 35.
  /* Same repair as sizeFor: an unreadable tier fell to 'medium' here, so the
     lever that moves the OpenAI price by a factor of 35 was picked by a
     spelling accident. */
  const quality =
    request.quality ?? TIER_QUALITY[normalizeTier(request.imageSize) ?? '2K'] ?? 'medium';

  try {
    /* Two different calls behind one adapter. Without references this is the
       JSON generations endpoint as before; with them it is the edits endpoint,
       multipart, one `image[]` part per reference. Content-Type is left unset
       on the multipart branch on purpose — fetch fills in the boundary, and
       setting it by hand produces a body the server cannot parse. */
    const editing = refs > 0;
    const res = editing
      ? await fetch(EDIT_ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: buildEditForm({ model, prompt: request.prompt, size, quality, refImages }),
        })
      : await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            prompt: request.prompt,
            size,
            quality,
            n: 1,
            // Half the bytes of png for the same picture, which the gallery
            // pays for on every view.
            output_format: 'jpeg',
            // input_fidelity is deliberately omitted. The SDK documents it for
            // "gpt-image-1.5 and later", so gpt-image-2 may well accept it;
            // omitting is the safe branch, but do not read the old claim that
            // it is REJECTED as established — nothing sourced it.
          }),
        });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        success: false,
        error: `OpenAI rejected the request (${res.status}): ${body.slice(0, 300)}`,
        generationTime: Date.now() - startTime,
        retryable: res.status === 429 || res.status >= 500,
      };
    }

    const json = (await res.json()) as {
      data?: { b64_json?: string; url?: string }[];
      usage?: { output_tokens?: number; output_tokens_details?: { image_tokens?: number } };
    };
    /* The bill for THIS image: gpt-image bills image output tokens at $30/1M
       (official rate, confirmed 2026-08-24). Carried out so the runtime
       price-drift detector can compare it with what we charge. */
    const imageOutputTokens = json.usage?.output_tokens_details?.image_tokens ?? json.usage?.output_tokens;
    const usage = typeof imageOutputTokens === 'number'
      ? { imageOutputTokens, costUsd: (imageOutputTokens * 30) / 1_000_000 }
      : undefined;
    const first = json.data?.[0];
    // gpt-image models always answer with base64 — there is no url to follow.
    if (!first?.b64_json) {
      return {
        success: false,
        error: 'OpenAI returned no image data',
        generationTime: Date.now() - startTime,
        retryable: true,
      };
    }

    const buffer = Buffer.from(first.b64_json, 'base64');
    const measured = readImageDimensions(buffer);

    return {
      success: true,
      usage,
      imageBuffers: [buffer],
      generationTime: Date.now() - startTime,
      metadata: {
        model,
        aspectRatio: request.aspectRatio || '1:1',
        // Measured, never echoed: the requested size and the delivered one are
        // different facts, and only one of them is true about the image.
        resolution: measured ? `${measured.width}x${measured.height}` : null,
        requestedSize: size,
        bytes: buffer.length,
        format: measured?.format ?? null,
      },
    };
  } catch (error: unknown) {
    /* An unreadable reference is the buyer's problem to fix, not a fault of
       the host, so it must not be retried and must not be blamed on OpenAI —
       a retryable verdict here would also charge the circuit breaker for an
       outage that never happened. */
    if (error instanceof UnreadableReferenceError) {
      return {
        success: false,
        error:
          `Reference image ${error.position} could not be read. ` +
          `Nothing was generated and nothing was charged. Re-upload it and try again.`,
        generationTime: Date.now() - startTime,
        retryable: false,
      };
    }
    return {
      success: false,
      error: `OpenAI error: ${error instanceof Error ? error.message : 'unknown'}`,
      generationTime: Date.now() - startTime,
      retryable: true,
    };
  }
}
