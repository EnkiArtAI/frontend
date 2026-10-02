import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

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
