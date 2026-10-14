import { describe, it, expect } from "vitest";
import { readSource } from "@/lib/__tests__/_read-source";
import { join } from "node:path";
import { toModelFamily } from "@/lib/generation/model-family";

/**
 * The buyer must receive the model they paid for.
 *
 * model_family is written onto the intent when the quote is taken, and the
 * price comes from it: nano-banana-pro and gpt-image-2 are $0.134 and $0.167
 * at 2K, $0.24 and $0.25 at 4K. Which model actually RUNS came from
 * body.modelIds — a separate input nothing compared to the intent.
 * "modelFamily" appeared exactly once in the whole route, as a field on a
 * metadata literal, and was never read again.
 */

const ROOT = join(__dirname, "..", "..", "..");
const ROUTE = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));

describe("the paid model family is enforced before generating", () => {
  it("compares the server-selected model with the stored paid family", () => {
    expect(ROUTE).toContain("toModelFamily(paidModel.name) !== paid.model_family");
    expect(ROUTE).toContain("await resolveModel(getSupabaseServerClientSafe(), [paid.model_id])");
  });

  it("uses only the stored model for provider preflight, never a body fallback", () => {
    expect(ROUTE).toContain("const preflightModel = paidModel;");
    expect(ROUTE).not.toContain("resolveModel(getSupabaseServerClientSafe(), body.modelIds)");
  });

  it("refuses a missing or mismatched model before claiming a unit or calling a provider", () => {
    const guard = ROUTE.indexOf("toModelFamily(paidModel.name) !== paid.model_family");
    const claim = ROUTE.indexOf("await claimGenerationEscrowUnit(");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
    expect(ROUTE.slice(guard, claim)).toContain("status: 409");
    expect(ROUTE.indexOf("generateImagesWithWaveSpeed(shared)")).toBeGreaterThan(claim);
  });
});

describe("toModelFamily is a stable key on both sides of the comparison", () => {
  it("normalises the display names the quote and the catalogue use", () => {
    expect(toModelFamily("Nano Banana Pro")).toBe("nano-banana-pro");
    expect(toModelFamily("GPT-Image-2")).toBe("gpt-image-2");
  });

  it("strips the parenthetical the picker adds, so a label change is not a price change", () => {
    expect(toModelFamily("GPT-Image-2 (coming soon)")).toBe(toModelFamily("GPT-Image-2"));
  });

  it("keeps the two paid families distinct — the whole comparison rests on it", () => {
    expect(toModelFamily("Nano Banana Pro")).not.toBe(toModelFamily("GPT-Image-2"));
    // and "Nano Banana" is a THIRD model, priced differently again
    expect(toModelFamily("Nano Banana")).not.toBe(toModelFamily("Nano Banana Pro"));
  });
});
