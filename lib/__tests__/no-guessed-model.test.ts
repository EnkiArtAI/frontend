import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";
import { generateImagesWithWaveSpeed } from "@/backend/services/wavespeed-image-generation";
import { generateImagesWithOpenAI } from "@/backend/services/openai-image-generation";
import { generateImagesWithGemini } from "@/backend/services/gemini-image-generation";

/**
 * ENG-01. Rule (Kev, 2026-09-22): a paid request never falls back to a guessed
 * model. The agent route built its provider request without modelVersion, so
 * every adapter picked its own default: gpt-image-2 at quality high landed on
 * WaveSpeed's nano-banana-pro default, the wrong model billed as gpt high.
 */

const ROOT = join(__dirname, "..", "..");
const X402 = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));

describe("the agent route sends the routed model", () => {
  it("passes route.providerModel as modelVersion, like the human route", () => {
    expect(X402).toMatch(/const genRequest: ImageGenerationRequest = \{[^}]*modelVersion: route\.providerModel,/);
  });

  it("refuses a route without a provider model before any money moves", () => {
    const guard = X402.search(/route\.provider !== "pollinations" && !route\.providerModel/);
    const settle = X402.search(/cosignAsFeePayer\(/);
    expect(guard).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(guard);
  });
});

describe("every paid adapter refuses a request without a model", () => {
  afterEach(() => vi.unstubAllEnvs());

  const adapters = [
    ["WaveSpeed", generateImagesWithWaveSpeed, "WAVESPEED_API_KEY"],
    ["OpenAI", generateImagesWithOpenAI, "OPENAI_API_KEY"],
    ["Gemini", generateImagesWithGemini, "GEMINI_API_KEY"],
  ] as const;

  for (const [name, generate, keyVar] of adapters) {
    it(`${name}: no modelVersion means MODEL_REQUIRED, not a default model`, async () => {
      // A configured key, so the refusal cannot come from a missing key.
      vi.stubEnv(keyVar, "test-key");
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const result = await generate({ prompt: "a red cube", aspectRatio: "1:1", numImages: 1 });
      expect(result.success).toBe(false);
      expect(result.code).toBe("MODEL_REQUIRED");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  }
});

describe("the human route refuses a route without a provider model before payment", () => {
  const HUMAN = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
  it("guards next to the IMPLEMENTED check, before the concurrency slot and any payment step", () => {
    const guard = HUMAN.search(/preflightRoute\.provider !== "pollinations" && !preflightRoute\.providerModel/);
    const slot = HUMAN.search(/const slot = await acquireSlot\(/);
    expect(guard).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(guard);
  });
});

// Live code only: tests may name the dead ids to prove they are gone.
const DEAD_IDS = ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"];
function liveFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === "__tests__" || n === "scripts" || n.startsWith(".")) return [];
    if (statSync(p).isDirectory()) return liveFiles(p);
    return /\.(ts|tsx|js|mjs)$/.test(n) ? [p] : [];
  });
}

describe("no live code names a Gemini model Google has shut down", () => {
  const files = ["app", "lib", "components", "hooks", "backend"].flatMap((d) => liveFiles(join(ROOT, d)));
  it("scans a real set of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });
  for (const id of DEAD_IDS) {
    it(`${id} appears nowhere, comments included`, () => {
      const hits = files.filter((f) => readFileSync(f, "utf8").includes(id));
      expect(hits).toEqual([]);
    });
  }
});
