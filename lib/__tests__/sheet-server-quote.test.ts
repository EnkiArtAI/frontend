import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The classic editor, its mobile sheet and Quick Create show server quotes
 * only (Kev, 2026-10-02: "ich brauche safe überall den server-quote"), and
 * the count a sheet shows and prices is the count it generates. Before:
 * a catalogue price with a $0.10 fallback, a 5% fee against the server's 10%,
 * a 20% refill discount the server never gave, a count that multiplied the
 * price while one image was made, and per-image selects that changed nothing.
 */
const ROOT = join(__dirname, "..", "..");
const SHEET = readSource(join(ROOT, "components", "EnkiMobileGenerateModal.tsx"));
const LAUNCHER = readSource(join(ROOT, "components", "GenerateLauncher.tsx"));
const EDITOR = readSource(join(ROOT, "components", "EnkiPromptEditor.tsx"));

describe("the mobile sheet", () => {
  it("shows the parent's server quote for exactly the count it generates", () => {
    expect(SHEET).toMatch(/<span className="mobile-modal-pay-inline-price">\{priceFor\(genCountNum\)\}<\/span>/);
    expect(SHEET).toMatch(/onClick=\{\(\) => onGenerate\(genCountNum\)\}/);
    expect(SHEET).not.toMatch(/computeGenerationPrice|PLATFORM_FEE_PERCENT|pricePerSlot/);
  });

  it("has no per-image selects that change nothing", () => {
    expect(SHEET).not.toMatch(/updateVariation\(i, \{ (model|ratio|resolution):/);
  });
});

describe("Quick Create", () => {
  it("prices from server quotes and generates the count it priced", () => {
    expect(LAUNCHER).toMatch(/const quotes = useServerQuotes\(/);
    expect(LAUNCHER).toMatch(/priceFor=\{priceFor\}/);
    expect(LAUNCHER).toMatch(/const generate = async \(count: number\) => \{/);
    expect(LAUNCHER).toMatch(/for \(let n = 0; n < count; n\+\+\) \{\n\s+const outcome = await runGeneration\(/);
    expect(LAUNCHER).not.toMatch(/t\.price|pricePerSlot/);
  });
});

describe("the classic editor", () => {
  it("prices every label from server quotes", () => {
    expect(EDITOR).toMatch(/const entryQuotes = useServerQuotes\(/);
    expect(EDITOR).not.toMatch(/getPricePerSlot|getBatchCost|getRefillCost|model\.price\.toFixed/);
    expect(EDITOR).toMatch(/priceFor=\{slotPrice\}/);
  });

  it("promises no refill discount the server does not give", () => {
    expect(EDITOR).not.toMatch(/\* 0\.8|refill discount/);
  });

  it("generates as many slots as the sheet priced", () => {
    expect(EDITOR).toMatch(/onGenerate=\{\(count\) => \{/);
    expect(EDITOR).toMatch(/const ids = Array\.from\(\{ length: count \}, \(_, i\) => base \+ i\);/);
  });
});

describe("the marketplace tiers and the shared helpers", () => {
  const PGV = readSource(join(ROOT, "components", "PromptGeneratorView.tsx"));
  const CORE = readSource(join(ROOT, "hooks", "useGenerationCore.ts"));
  const LIMITS = readSource(join(ROOT, "hooks", "useModelLimits.ts"));
  const QUALITY = readSource(join(ROOT, "components", "generation", "QualitySelect.tsx"));

  it("each tier shows the server's quote for this prompt", () => {
    expect(PGV).toMatch(/const tierQuotes = useServerQuotes\(/);
    expect(PGV).toMatch(/priceLabel: noCharge \? undefined : quoteLabel\(tierQuotes\[i\]\) \?\? undefined/);
  });

  it("no surface can compute a price in the browser any more", () => {
    expect(CORE).not.toMatch(/tierPrice|tierScale|price:/);
    expect(LIMITS).not.toMatch(/export function tierPrice|export function tierScale/);
  });

  it("the quality hints make no price claims", () => {
    expect(QUALITY).not.toMatch(/\d+x the price/);
  });
});
