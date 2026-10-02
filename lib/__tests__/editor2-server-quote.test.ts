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
    expect(NODE).toMatch(/<span className="nc-genbtn-sub">\{priceFor\(1\)\}<\/span>/);
    expect(NODE).toMatch(/const total = priceFor\(genConfirm\.checked\.size\);/);
    expect(DOC).toMatch(/<span className="ncd-gen-price">\{priceLabel\}<\/span>/);
    expect(DOC).toMatch(/sub: api\.modelPriceLabel\(mm\.id\)/);
    expect(DOC).toMatch(/sub: api\.tierPriceLabel\(q\)/);
  });

  it("no longer claims quality is free", () => {
    expect(NODE + DOC).not.toMatch(/same on every setting/);
  });
});
