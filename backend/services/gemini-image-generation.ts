/**
 * Google Gemini (Nano Banana) Image Generation Service
 *
 * Integrates with Gemini 3 Pro Image (Nano Banana Pro) for high-quality
 * image generation with best-in-class text rendering.
 *
 * Models:
 * - gemini-3-pro-image: High-fidelity with "Thinking" mode ($0.134/image at 1K and 2K)
 *
 * Rate Limits (Free Tier):
 * - 2 images per minute
 * - 250 requests per day
 *
 * Rate Limits (Paid Tier 1):
 * - 10 images per minute
 * - Unlimited daily quota
 */

import { GoogleGenAI, Modality } from '@google/genai';
import type { ImageGenerationRequest, ImageGenerationResult } from './types';
import { missingModel } from './model-required';

// Initialize Gemini AI client
let ai: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!ai) {
    // Support both GEMINI_API_KEY and GOOGLE_GEMINI_API_KEY for compatibility
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error(
        'GOOGLE_GEMINI_API_KEY or GEMINI_API_KEY environment variable is not set. ' +
        'Get your API key from https://aistudio.google.com/apikey'
      );
    }

    ai = new GoogleGenAI({ apiKey });
  }

  return ai;
}

/**
 * Generates images using Google Gemini (Nano Banana)
 *
 * @param request - Generation request parameters
 * @returns URLs or buffers of generated images
 *
 * @example
 * ```typescript
 * const result = await generateImagesWithGemini({
 *   prompt: 'A futuristic city with neon lights',
 *   aspectRatio: '16:9',
 *   numImages: 1
 * });
 *
 * if (result.success) {
 *   console.log('Generated images:', result.imageUrls);
 * }
 * ```
 */
export async function generateImagesWithGemini(
  request: ImageGenerationRequest
): Promise<ImageGenerationResult> {
  const startTime = Date.now();
  const model = request.modelVersion;
  if (!model) return missingModel(startTime);
  // Said like the other adapters. Thrown from getGeminiClient, the catch below
  // read "API key" in its text and reported an INVALID key, which opens the
  // breaker for every Gemini route in the shared database (ENV-01).
  if (!process.env.GOOGLE_GEMINI_API_KEY && !process.env.GEMINI_API_KEY) {
    return { success: false, error: "GEMINI_API_KEY is not set", generationTime: 0, retryable: false };
  }

  try {
    // 1. Validate request
    const validation = validateRequest(request);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        generationTime: Date.now() - startTime
      };
    }

    // 2. Get Gemini client
    const client = getGeminiClient();

    // 4. Build generation config
    const config: any = {
      responseModalities: [Modality.IMAGE], // Request image output
      imageConfig: {
        aspectRatio: request.aspectRatio || '1:1',
      }
    };

    // Every image model with a known rate takes imageSize (1K, 2K, 4K)
    if (imageTokenRate(model) !== null && request.imageSize) {
      config.imageConfig.imageSize = request.imageSize;
    }

    // Add safety settings if provided
    if (request.safetySettings) {
      config.safetySettings = request.safetySettings;
    }

    console.log(`[Gemini] Generating image with model: ${model}`);
    // Length only: a paid marketplace prompt reaches here as the artist's own text,
    // and these logs are shared output.
    console.log(`[Gemini] Prompt: ${request.prompt.length} chars`);

    // 5. Build the parts: the text prompt, then any reference images as
    // inlineData. `data` must be BARE base64 — leaving the "data:...;base64,"
    // prefix on it returns a 400 from the API (mutation-tested against the
    // live endpoint, 2026-08-06). Never set inlineData.displayName: the SDK
    // throws on it for the Gemini API.
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: request.prompt },
    ];
    /* Every attached reference has to make it, or the request fails.
     *
     * This used to be `if (parsed) parts.push(...)`, which quietly used the
     * ones it could read and threw the rest away. A buyer attaching five
     * images and getting three used would be charged in full and told
     * nothing — the same silent-loss failure that made the WaveSpeed and
     * OpenAI adapters refuse outright, just in a smaller dose and harder to
     * notice, because the picture does honour SOME of the references.
     */
    const unreadable: number[] = [];
    (request.referenceImages ?? []).forEach((ref, i) => {
      const parsed = parseImageInput(ref);
      if (parsed) parts.push({ inlineData: parsed });
      else unreadable.push(i + 1);
    });
    if (unreadable.length > 0) {
      return {
        success: false,
        error:
          `Reference image${unreadable.length === 1 ? "" : "s"} ${unreadable.join(", ")} could not be read. ` +
          `Nothing was generated and nothing was charged. Re-upload ${unreadable.length === 1 ? "it" : "them"} and try again.`,
        generationTime: Date.now() - startTime,
        retryable: false,
      };
    }
    const refCount = parts.length - 1;
    if (refCount > 0) console.log(`[Gemini] Using ${refCount} reference image(s)`);

    // 6. Generate image
    const response = await client.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config
    });

    // 6. Extract image data
    const imageBuffers: Buffer[] = [];
    let finishReason: string | undefined;
    let safetyRatings: any[] | undefined;

    if (!response.candidates || response.candidates.length === 0) {
      return {
        success: false,
        error: 'No images generated. The request may have been blocked by safety filters.',
        generationTime: Date.now() - startTime
      };
    }

    for (const candidate of response.candidates) {
      finishReason = candidate.finishReason;
      safetyRatings = candidate.safetyRatings;

      // Check if generation was blocked
      if (finishReason === 'SAFETY') {
        return {
          success: false,
          error: 'Image generation blocked by safety filters. Please modify your prompt.',
          generationTime: Date.now() - startTime,
          metadata: {
            model,
            aspectRatio: request.aspectRatio || '1:1',
            // Blocked before any image existed, so there is nothing to measure.
            resolution: null,
            requestedSize: request.imageSize ?? null,
            bytes: null,
            format: null,
            finishReason,
            safetyRatings
          }
        };
      }

      /* Extract image data from parts, keeping the model's own drafts out.
         Thinking is on by default for the Gemini 3 image models and cannot be
         switched off through the API, and the docs say it "generates up to two
         interim images to test composition and logic". Those parts arrive
         marked thought: true. This loop took every inlineData part, so one
         generation could hand the buyer three images and — worse — make
         imageBuffers[0] a draft, which is the buffer the caller delivers and
         measures for output_width/height.

         The drafts are a FALLBACK rather than a hard filter, because the same
         page says "the last image within Thinking is also the final rendered
         image": if a response somehow carries nothing else, the last draft is
         the picture, and returning it beats failing the generation. */
      if (candidate.content && candidate.content.parts) {
        const drafts: Buffer[] = [];
        for (const part of candidate.content.parts) {
          if (part.inlineData && part.inlineData.data && typeof part.inlineData.data === 'string') {
            const buffer = Buffer.from(part.inlineData.data, 'base64');
            if ((part as { thought?: boolean }).thought) {
              drafts.push(buffer);
              continue;
            }
            imageBuffers.push(buffer);
            console.log(`[Gemini] Extracted image: ${buffer.length} bytes`);
          }
        }
        if (imageBuffers.length === 0 && drafts.length > 0) {
          const last = drafts[drafts.length - 1];
          imageBuffers.push(last);
          console.log(`[Gemini] No final part; using the last thinking image: ${last.length} bytes`);
        } else if (drafts.length > 0) {
          console.log(`[Gemini] Skipped ${drafts.length} thinking image(s)`);
        }
      }
    }

    if (imageBuffers.length === 0) {
      return {
        success: false,
        error: 'No image data received from Gemini API',
        generationTime: Date.now() - startTime
      };
    }

    const generationTime = Date.now() - startTime;
    const measured = readImageDimensions(imageBuffers[0]);
    console.log(
      `[Gemini] Generation completed in ${generationTime}ms` +
      (measured ? ` — ${measured.width}x${measured.height} ${measured.format}, ${imageBuffers[0].length} bytes` : ''),
    );

    /* The bill for THIS image: image output tokens at the model's rate
       (imageTokenRate). Carried out for the runtime price-drift detector. */
    const imageOutputTokens = (response as { usageMetadata?: { candidatesTokenCount?: number } }).usageMetadata?.candidatesTokenCount;
    const rate = imageTokenRate(model);
    const usage = typeof imageOutputTokens === 'number' && rate !== null
      ? { imageOutputTokens, costUsd: (imageOutputTokens * rate) / 1_000_000 }
      : undefined;

    return {
      success: true,
      usage,
      imageBuffers,
      generationTime,
      metadata: {
        model,
        aspectRatio: request.aspectRatio || '1:1',
        // Measured from the bytes we actually received, not echoed back from
        // the request. imageSize is only honoured by gemini-3-pro-image, so
        // echoing it recorded "2K" for 1024x1024 images on every other model.
        resolution: measured ? `${measured.width}x${measured.height}` : null,
        requestedSize: request.imageSize ?? null,
        bytes: imageBuffers[0]?.length ?? null,
        format: measured?.format ?? null,
        finishReason,
        safetyRatings
      }
    };

  } catch (error: any) {
    const generationTime = Date.now() - startTime;
    console.error('[Gemini] Generation error:', error);

    // Handle specific error types
    if (error.status === 429 || error.message?.includes('rate limit')) {
      return {
        success: false,
        error: 'Rate limit exceeded. Please try again in a moment.',
        generationTime,
        retryable: true
      };
    }

    if (error.status === 401 || error.message?.includes('API key')) {
      return {
        success: false,
        error: 'Invalid API key. Please check GOOGLE_GEMINI_API_KEY environment variable.',
        generationTime,
        retryable: false
      };
    }

    if (error.status === 400) {
      return {
        success: false,
        error: `Invalid request: ${error.message}`,
        generationTime,
        retryable: false
      };
    }

    if (error.status >= 500) {
      return {
        success: false,
        error: 'Gemini service error. Please try again later.',
        generationTime,
        retryable: true
      };
    }

    return {
      success: false,
      error: error.message || 'Image generation failed',
      generationTime,
      retryable: true
    };
  }
}

/**
 * Generates multiple images by making parallel requests to Gemini
 *
 * Note: Gemini generates 1 image per request, so we make multiple requests
 * in parallel to generate multiple images.
 *
 * @param request - Generation request with numImages > 1
 * @returns Combined results from all generations
 */
export async function generateMultipleImagesWithGemini(
  request: ImageGenerationRequest
): Promise<ImageGenerationResult> {
  const numImages = request.numImages || 1;

  if (numImages === 1) {
    return generateImagesWithGemini(request);
  }

  console.log(`[Gemini] Generating ${numImages} images in parallel`);

  // Generate multiple images in parallel
  const promises = Array.from({ length: numImages }, () =>
    generateImagesWithGemini({ ...request, numImages: 1 })
  );

  const results = await Promise.all(promises);

  // Combine results
  const allImageBuffers: Buffer[] = [];
  const errors: string[] = [];
  let totalTime = 0;
  let anyRetryable = false;

  let usageTokens = 0;
  let usageSeen = false;
  const rate = imageTokenRate(request.modelVersion);
  for (const result of results) {
    if (result.success && result.imageBuffers) {
      allImageBuffers.push(...result.imageBuffers);
      if (typeof result.usage?.imageOutputTokens === 'number') {
        usageTokens += result.usage.imageOutputTokens;
        usageSeen = true;
      }
    } else if (result.error) {
      errors.push(result.error);
      if (result.retryable) {
        anyRetryable = true;
      }
    }
    totalTime = Math.max(totalTime, result.generationTime || 0);
  }

  // If we got at least some images, consider it a success
  if (allImageBuffers.length > 0) {
    return {
      success: true,
      // Per-image bill: the drift detector compares ONE image with ONE cell.
      usage: usageSeen && rate !== null
        ? { imageOutputTokens: usageTokens / allImageBuffers.length, costUsd: ((usageTokens / allImageBuffers.length) * rate) / 1_000_000 }
        : undefined,
      imageBuffers: allImageBuffers,
      generationTime: totalTime,
      error: errors.length > 0
        ? `Generated ${allImageBuffers.length}/${numImages} images. Errors: ${errors.join('; ')}`
        : undefined
    };
  }

  // All generations failed
  return {
    success: false,
    error: `All generations failed: ${errors.join('; ')}`,
    generationTime: totalTime,
    retryable: anyRetryable
  };
}

/**
 * Validates image generation request
 */
/**
 * Turns a reference image into Gemini's inlineData shape.
 * Accepts a data URL or a bare base64 payload; returns null for junk.
 */
export function parseImageInput(input: string): { mimeType: string; data: string } | null {
  if (!input || typeof input !== "string") return null;
  // [\s\S] rather than the `s` (dotAll) flag — the build target rejects es2018
  // regex flags, which broke a Vercel build once already.
  const match = input.match(/^data:([\s\S]+?);base64,([\s\S]*)$/);
  if (match) return match[2] ? { mimeType: match[1], data: match[2] } : null;
  const data = input.trim();
  return data ? { mimeType: "image/png", data } : null;
}

/**
 * Real pixel dimensions, read straight from the container header.
 *
 * Deliberately not sharp: this runs on every generation, and sharp is only an
 * optional transitive of Next — a dependency this hot path should not acquire
 * for twenty bytes of header. PNG carries width/height in the IHDR chunk at a
 * fixed offset; JPEG needs a walk to the first Start-Of-Frame marker.
 */
/**
 * $ per 1M image output tokens for the Gemini image models we run (official
 * pricing page). Only these are sent imageSize: a model missing here renders
 * at 1024² whatever the buyer paid for, so a new one needs its row.
 */
const IMAGE_TOKEN_RATE = new Map([
  ['gemini-3-pro-image', 120],
  ['gemini-3.1-flash-image', 60],
]);

export function imageTokenRate(model: string | null | undefined): number | null {
  return IMAGE_TOKEN_RATE.get(model ?? '') ?? null;
}

/**
 * Is this the Gemini 3 Pro Image model? Only the cost estimate below still
 * branches on it.
 *
 * Only the GA id. Google shut the preview id down on 2026-06-25, and the live
 * model_providers rows carry gemini-3-pro-image (read 2026-10-02).
 */
export function isGemini3ProImage(model: string | null | undefined): boolean {
  return model === 'gemini-3-pro-image';
}

export function readImageDimensions(
  buf: Buffer | undefined,
): { width: number; height: number; format: 'png' | 'jpeg' } | null {
  if (!buf || buf.length < 24) return null;

  // PNG: 8-byte signature, then the IHDR chunk with width/height at 16..24.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }

  // JPEG: walk the segments to the first SOF, which holds the frame size.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // Any SOFn except DHT (c4), JPG (c8) and DAC (cc) carries the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: 'jpeg' };
      }
      // Standalone markers carry no length field; everything else does.
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }

  return null;
}

function validateRequest(request: ImageGenerationRequest): { valid: boolean; error?: string } {
  if (!request.prompt || request.prompt.trim().length === 0) {
    return { valid: false, error: 'Prompt is required and cannot be empty' };
  }

  if (request.prompt.length > 5000) {
    return { valid: false, error: 'Prompt is too long (max 5000 characters)' };
  }

  // Kept in step with ImageGenerationRequest['aspectRatio'] in ./types.ts.
  // Verified by real Gemini calls (2026-08-06): all ten
  // are accepted. The previous five-entry list rejected 4:5, which the live
  // models table offers users — a 400 we inflicted on ourselves after payment.
  const validAspectRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
  if (request.aspectRatio && !validAspectRatios.includes(request.aspectRatio)) {
    return {
      valid: false,
      error: `Invalid aspect ratio. Must be one of: ${validAspectRatios.join(', ')}`
    };
  }

  if (request.numImages && (request.numImages < 1 || request.numImages > 4)) {
    return {
      valid: false,
      error: 'Number of images must be between 1 and 4'
    };
  }

  const validImageSizes = ['1K', '2K', '4K'];
  if (request.imageSize && !validImageSizes.includes(request.imageSize)) {
    return {
      valid: false,
      error: `Invalid image size. Must be one of: ${validImageSizes.join(', ')}`
    };
  }

  return { valid: true };
}

/**
 * Estimates the cost of a Gemini image generation
 *
 * @param model - The model to use
 * @param imageSize - The image resolution
 * @param numImages - Number of images to generate
 * @returns Estimated cost in USD
 */
export function estimateGeminiCost(
  model: string,
  imageSize: string = '1K',
  numImages: number = 1
): number {
  let costPerImage = 0;

  if (isGemini3ProImage(model)) {
    // Vertex AI pricing
    const tokenCounts: Record<string, number> = {
      '1K': 1120,
      '2K': 1120,
      '4K': 2000
    };
    const tokens = tokenCounts[imageSize] || 1120;
    costPerImage = (tokens / 1_000_000) * 120; // $0.134 for 1K/2K, $0.240 for 4K
  }

  return costPerImage * numImages;
}

// Export for testing
export const __testing__ = {
  validateRequest,
  estimateGeminiCost
};
