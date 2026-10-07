import { describe, it, expect, vi, afterEach } from "vitest";
import { generateImagesWithGemini } from "@/backend/services/gemini-image-generation";
import { generateImagesWithOpenAI } from "@/backend/services/openai-image-generation";
import { generateImagesWithWaveSpeed } from "@/backend/services/wavespeed-image-generation";
import { classifyFailure, shouldOpen } from "@/lib/generation/provider-health";

/**
 * ENV-01. Developer deployments run without provider keys against the live
 * database, where the provider breaker keeps its state. Gemini reported a
 * missing key as an INVALID one, which opens the breaker for every Gemini
 * route at once, production's included. Every adapter now says the key is
 * not set, and that never opens anything.
 */

afterEach(() => vi.unstubAllEnvs());

const request = { prompt: "a lighthouse at dusk", aspectRatio: "1:1" as const, numImages: 1 };

describe("a deployment without a provider key", () => {
  it.each([
    ["Gemini", () => generateImagesWithGemini({ ...request, modelVersion: "gemini-3-pro-image-preview" }), ["GOOGLE_GEMINI_API_KEY", "GEMINI_API_KEY"]],
    ["OpenAI", () => generateImagesWithOpenAI({ ...request, modelVersion: "gpt-image-2" }), ["OPENAI_API_KEYS", "OPENAI_API_KEY"]],
    ["WaveSpeed", () => generateImagesWithWaveSpeed({ ...request, modelVersion: "google/nano-banana-pro/text-to-image" }), ["WAVESPEED_API_KEY"]],
  ] as const)("%s says the key is not set, and the breaker stays shut", async (_name, run, keys) => {
    for (const k of keys) vi.stubEnv(k, "");
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/_API_KEY is not set$/);
    expect(shouldOpen(classifyFailure(result.error!), 99)).toBe(false);
  });
});
