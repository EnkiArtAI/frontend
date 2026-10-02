import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Every price Editor 2 shows is a server quote (Kev, 2026-10-02: "ich brauche
 * safe überall den server-quote"). The labels were catalogue price x tier
 * scale, without the 10% fee and without quality, and the quality tooltip
 * claimed the price never changes.
 */
const ROOT = join(__dirname, "..", "..");
const NODE = readSource(join(ROOT, "components", "enki-shell", "NodeCreator.tsx"));
const DOC = readSource(join(ROOT, "components", "enki-shell", "DocView.tsx"));

describe("Editor 2 shows server quotes only", () => {
  it("prices every model and tier option through one batch of server quotes", () => {
    expect(NODE).toMatch(/const quotes = useServerQuotes\(\[/);
    expect(NODE).toMatch(/const priceFor = \(n: number\) => \(selectedModel\?\.free \? "Free" : quoteLabel\(nowQuote, n\) \?\? "…"\);/);
  });

  it("computes no price in the browser", () => {
    for (const src of [NODE, DOC]) {
      expect(src).not.toMatch(/perImage|shownCost|apiBoostPricePerImage|tierPrice\(|tierScale\(/);
      expect(src).not.toMatch(/(mm|m|selectedModel\??)\.price\.toFixed|\(selectedModel\?\.price/);
    }
  });

  it("every price label reads the quote", () => {
    expect(NODE.match(/\{priceFor\(imgCount\)\}/g)?.length).toBe(2);
    // The prompt-node Generate fills every empty slot of the composition.
    expect(NODE).toMatch(/<span className="nc-genbtn-sub">\{priceFor\(fillCount\)\}<\/span>/);
    expect(NODE).toMatch(/priceLabel: priceFor\(fillCount\)/);
    expect(NODE).toMatch(/const fillCount = Math\.max\(1, outs\.filter\(\(o\) => o\.status === "empty" && \(!o\.sig \|\| o\.sig === curSig\)\)\.length\);/);
    expect(NODE).toMatch(/const total = priceFor\(genConfirm\.checked\.size\);/);
    expect(DOC).toMatch(/<span className="ncd-gen-price">\{priceLabel\}<\/span>/);
    expect(DOC).toMatch(/sub: api\.modelPriceLabel\(mm\.id\)/);
    expect(DOC).toMatch(/sub: api\.tierPriceLabel\(q\)/);
  });

  it("no longer claims quality is free", () => {
    expect(NODE + DOC).not.toMatch(/same on every setting/);
  });
});

describe("Editor 2 runs the tier it shows", () => {
  it("prices and generates the clamped tier, never a stored one above the model's ceiling", () => {
    expect(NODE).toMatch(/const tierNow = asTier\(effTier\);/);
    expect(NODE).toMatch(/const tiers = tiersUpTo\(picked\?\.maxResolution \?\? "2K"\);/);
    expect(NODE).toMatch(/tiers\.includes\(wanted as never\) \? wanted : tiers\[tiers\.length - 1\]/);
  });
});
