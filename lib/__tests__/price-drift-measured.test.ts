import { describe, it, expect } from "vitest";
import { driftOf } from "@/lib/generation/price-drift";
import { apiPricePerImage, apiBoostPricePerImage } from "@/lib/pricing";

/**
 * The table equals what Gemini bills (Kev, 2026-10-13: "EXAKT DEM API PREIS +
 * fee"). These are the bills the devnet run logged as drift, so the detector
 * must now read them as no drift at all.
 */
describe("the price table carries the measured Gemini bill", () => {
  it.each([
    ["nano-banana-pro", "2K", 0.1476],
    ["nano-banana-pro", "4K", 0.2525],
    ["nano-banana-2", "1K", 0.0913],
  ])("%s %s billed $%s: no drift", (modelFamily, resolution, observedUsd) => {
    const d = driftOf({ provider: "gemini", modelFamily, resolution, observedUsd });
    expect(d.expectedUsd).toBe(observedUsd);
    expect(d.ratio).toBe(1);
    expect(d.drifted).toBe(false);
    // The charged model leg is that same bill: the fee comes on top of it, nothing hides inside.
    expect(apiPricePerImage(modelFamily, resolution)).toBe(observedUsd);
  });

  it.each([
    ["2K", 0.1251],
    ["4K", 0.1763],
  ])("nano-banana-2 %s on Gemini direct (the boost route) billed $%s: no drift", (resolution, observedUsd) => {
    const d = driftOf({ provider: "gemini", modelFamily: "nano-banana-2", resolution, observedUsd });
    expect(d.ratio).toBe(1);
    expect(apiBoostPricePerImage("nano-banana-2", resolution)).toBe(observedUsd);
  });

  it.each([
    ["low", 0.006],
    ["medium", 0.0539],
    ["high", 0.2153],
  ])("gpt-image-2 1K %s billed $%s: its own cell, not the 2K price", (quality, observedUsd) => {
    // OpenAI bills 1K at about half of 2K; the matrix had no 1K cell and charged the 2K price (devnet 2026-10-13).
    const d = driftOf({ provider: "openai", modelFamily: "gpt-image-2", resolution: "1K", quality, observedUsd });
    expect(d.ratio).toBe(1);
    expect(apiPricePerImage("gpt-image-2", "1K", quality)).toBe(observedUsd);
  });

  it("still flags the old table values as drift", () => {
    expect(driftOf({ provider: "gemini", modelFamily: "nano-banana-pro", resolution: "2K", observedUsd: 0.134 }).drifted).toBe(true);
  });
});
