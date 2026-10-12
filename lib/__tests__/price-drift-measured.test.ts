import { describe, it, expect } from "vitest";
import { driftOf } from "@/lib/generation/price-drift";
import { apiPricePerImage } from "@/lib/pricing";

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

  it("still flags the old table values as drift", () => {
    expect(driftOf({ provider: "gemini", modelFamily: "nano-banana-pro", resolution: "2K", observedUsd: 0.134 }).drifted).toBe(true);
  });
});
