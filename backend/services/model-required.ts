import type { ImageGenerationResult } from './types';

/**
 * A paid request never falls back to a guessed model (Kev, 2026-09-22).
 * Every paid adapter returns this when the caller sent no modelVersion,
 * before any provider call, so nothing is generated and nothing is charged.
 */
export function missingModel(startTime: number): ImageGenerationResult {
  return {
    success: false,
    code: 'MODEL_REQUIRED',
    error: 'No model was given for this generation. Nothing was generated and nothing was charged.',
    generationTime: Date.now() - startTime,
    retryable: false,
  };
}
