/**
 * Pollinations.ai Image Generation Service
 * 
 * Completely FREE, no API key required.
 * Uses Pollinations.ai's public API for image generation.
 * 
 * Supported models: flux, turbo
 * Rate limits: Fair use (typically ~10 req/min)
 */

import type { ImageGenerationResult } from './types';
import { readImageDimensions } from './gemini-image-generation';

/**
 * Total pixels the free tier will actually render.
 *
 * The provider clamps by TOTAL PIXEL COUNT, preserving aspect ratio, and it
 * does so BEFORE the diffusion call — so pixels asked for above the budget
 * are never rendered, they are silently dropped. Measured 2026-08-12
 * (768x960 and 1024x1280 both came back 686x858, which is exactly this
 * budget reshaped to 4:5) and confirmed in their worker source, where
 * find_nearest_valid_dimensions() rescales by sqrt(MAX_PIXELS / requested)
 * and the CLAMPED values are what reach the model.
 *
 * A cap on one SIDE cannot express that, which is how the first attempt at
 * this went wrong: at a 768 base only 1:1 lands inside the budget. 4:5 is
 * 25% over, 4:3 is 33%, 2:3 is 50%, 16:9 is 78%, 2.39:1 is 139%. Eight of
 * the nine ratios this adapter offers were still over-asking. The budget
 * belongs on the product, applied with the provider's own formula.
 *
 * 589,824 is what the worker that served us was configured with. Pollinations
 * set this per worker through an env var (their code default is 810,000,
 * their provisioning script sets 1,048,576), so the true ceiling is a lottery
 * across the pool rather than a property of the API. This is therefore a
 * deliberately conservative floor, raisable without a code change once
 * somebody measures what the pool actually offers.
 */
const MAX_PIXELS = Number(process.env.POLLINATIONS_MAX_PIXELS) || 589_824;

/** Aspect-preserving shrink to the pixel budget — the provider's own formula. */
function fitToPixelBudget(width: number, height: number): { width: number; height: number } {
  const pixels = width * height;
  if (pixels <= MAX_PIXELS) return { width, height };
  const scale = Math.sqrt(MAX_PIXELS / pixels);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

interface PollinationsRequest {
  prompt: string;
  width?: number;
  height?: number;
  model?: string;
  seed?: number;
  nologo?: boolean;
  enhance?: boolean;
}

/**
 * Get dimensions from aspect ratio string
 */
function getDimensions(aspectRatio: string, resolution: string): { width: number; height: number } {
  // The ladder stays intact — it is what the caller asked for, and the budget
  // below is what the provider will honour. Keeping the two separate means
  // raising POLLINATIONS_MAX_PIXELS makes 4K genuinely larger than 2K again,
  // instead of the ladder being flattened here where nobody can see it.
  const baseSize = resolution === '4K' ? 1024 : resolution === '2K' ? 768 : 512;
  const { width, height } = rawDimensions(aspectRatio, baseSize);
  return fitToPixelBudget(width, height);
}

function rawDimensions(aspectRatio: string, baseSize: number): { width: number; height: number } {
  switch (aspectRatio) {
    case '16:9':
      return { width: Math.round(baseSize * (16 / 9)), height: baseSize };
    case '9:16':
      return { width: baseSize, height: Math.round(baseSize * (16 / 9)) };
    case '4:3':
      return { width: Math.round(baseSize * (4 / 3)), height: baseSize };
    case '3:4':
      return { width: baseSize, height: Math.round(baseSize * (4 / 3)) };
    case '4:5':
      return { width: baseSize, height: Math.round(baseSize * (5 / 4)) };
    case '2:3':
      return { width: baseSize, height: Math.round(baseSize * (3 / 2)) };
    case '2.39:1':
      return { width: Math.round(baseSize * 2.39), height: baseSize };
    case '1:2.39':
      return { width: baseSize, height: Math.round(baseSize * 2.39) };
    case '1:1':
    default:
      return { width: baseSize, height: baseSize };
  }
}

/**
 * Generate image using Pollinations.ai (FREE, no API key)
 */
export async function generateImageWithPollinations(
  prompt: string,
  aspectRatio: string = '1:1',
  resolution: string = '2K',
): Promise<ImageGenerationResult> {
  const startTime = Date.now();

  try {
    if (!prompt || prompt.trim().length === 0) {
      return {
        success: false,
        error: 'Prompt is required',
        generationTime: Date.now() - startTime,
      };
    }

    const { width, height } = getDimensions(aspectRatio, resolution);

    /* Anonymous traffic is throttled to roughly one queued request per IP —
       the ~41s wait a user sees on the free path — and Pollinations now answers
       402 for some of it outright. A free token from https://auth.pollinations.ai
       lifts the queue; POLLINATIONS_REFERRER only identifies the app.

       The token is a credential: it is never logged, never put in an error
       message, and only its PRESENCE is ever printed. */
    const token = process.env.POLLINATIONS_TOKEN?.trim();
    const referrer = process.env.POLLINATIONS_REFERRER?.trim();

    // Pollinations.ai URL-based API - returns image directly
    const encodedPrompt = encodeURIComponent(prompt);
    const seed = Math.floor(Math.random() * 999999);
    const params = new URLSearchParams({
      width: String(width),
      height: String(height),
      seed: String(seed),
      enhance: 'true',
      model: 'flux',
      // Kept out of Pollinations' public feed: the prompt is in the URL, and
      // a paid prompt's text is the artist's secret.
      private: 'true',
    });
    // nologo is a paid-tier feature; asking for it anonymously is noise.
    if (token) params.set('nologo', 'true');
    if (referrer) params.set('referrer', referrer);
    // Sent both ways deliberately: the query parameter is what Pollinations
    // documents for its URL API, the Bearer header is the form its newer auth
    // accepts. Neither is logged.
    if (token) params.set('token', token);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?${params.toString()}`;

    console.log(`[Pollinations] Generating image: ${width}x${height}${token ? ' (token)' : ' (anonymous)'}`);
    // Length only: a paid prompt's text is the artist's secret, and logs are
    // read by everyone with access to the deployment.
    console.log(`[Pollinations] Prompt: ${prompt.length} chars`);

    // Fetch the image to get the buffer (Pollinations returns the image directly)
    const response = await fetch(imageUrl, {
      headers: {
        'Accept': 'image/*',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      /* 402 means the anonymous tier refused outright. Saying so is the whole
         point: without this the caller reported a generic 500 and nobody could
         tell a throttle from a misconfiguration. */
      if (response.status === 402) {
        return {
          success: false,
          error: token
            ? 'Pollinations rejected the request (402). The token may be invalid or out of quota.'
            : 'The free generator now needs an API token. Set POLLINATIONS_TOKEN (free at https://auth.pollinations.ai).',
          generationTime: Date.now() - startTime,
          retryable: false,
        };
      }
      // 429 is the free tier's normal answer to a burst — measured
      // 2026-08-12, three requests in a row after a handful of renders. It is
      // the most retryable failure there is, and reporting it as a plain
      // server error made the route answer 500 and the user read "generation
      // failed" for something that works again seconds later.
      const rateLimited = response.status === 429;
      return {
        success: false,
        error: rateLimited
          ? 'The free generator is busy right now. Try again in a moment.'
          : `Pollinations API error: ${response.status} ${response.statusText}`,
        generationTime: Date.now() - startTime,
        retryable: rateLimited || response.status >= 500,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const generationTime = Date.now() - startTime;
    console.log(`[Pollinations] Generation completed in ${generationTime}ms (${buffer.length} bytes)`);

    // metadata.resolution is contractually WHAT CAME BACK, measured from the
    // bytes (see ImageGenerationResult in ./types). This adapter was echoing
    // the caller's label instead, so a record could read "4K" for an image the
    // provider rendered at 0.59 MP. The label the caller passed is still kept,
    // as requestedSize, so the two can be compared rather than confused.
    const measured = readImageDimensions(buffer);

    return {
      success: true,
      imageBuffers: [buffer],
      generationTime,
      metadata: {
        model: 'pollinations-flux',
        aspectRatio,
        resolution: measured ? `${measured.width}x${measured.height}` : null,
        requestedSize: `${width}x${height}`,
        bytes: buffer.length,
        format: measured?.format ?? null,
      },
    };

  } catch (error: any) {
    const generationTime = Date.now() - startTime;
    console.error('[Pollinations] Generation error:', error);

    return {
      success: false,
      error: error.message || 'Image generation failed',
      generationTime,
      retryable: true,
    };
  }
}
