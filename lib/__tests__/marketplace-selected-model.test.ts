import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The marketplace generator reset any pick missing from its name list to the
 * list's first entry (the cheapest row, Flux), invented model names before the
 * catalogue loaded, ignored the prompt's own model, and paid for boost and
 * quality from a stale closure. It now runs the buyer's pick, or the prompt's
 * own model, through runGeneration.
 */
const PGV = readSource(join(__dirname, "..", "..", "components", "PromptGeneratorView.tsx"));

describe("the marketplace generator runs the selected model", () => {
  it("never resets a pick and invents no names", () => {
    expect(PGV).not.toMatch(/setGenerator\(GENERATORS\[0\]\)/);
    expect(PGV).not.toMatch(/"Nano Banana Pro"|Seedream 5\.0 lite \(coming soon\)/);
    expect(PGV).toMatch(/const \[generatorPick, setGenerator\] = useState\(""\);/);
  });

  it("preselects only the prompt's own model, and the buyer's pick wins", () => {
    expect(PGV).toMatch(/const generator = generatorPick \|\| promptModelName;/);
    expect(PGV).toMatch(/const m = prompt\?\.ai_model;/);
  });

  it("generates through runGeneration with the resolved entry and the prompt", () => {
    expect(PGV).toMatch(/const outcome = await runGeneration\(\n\s+\{\n\s+model: core\.entry,/);
    expect(PGV).toMatch(/promptId: promptId \|\| undefined,/);
    expect(PGV).not.toMatch(/\/api\/generate-free/);
  });

  it("quotes the boost that will run, not a hidden one", () => {
    expect(PGV).toMatch(/fetchGenerationQuote\(\{ promptId: promptId!, modelId: core\.entry!\.id, resolution: quoteResolution, boost: core\.boostAt\(quoteResolution\) && boost, quality \}\)/);
  });

  it("free is the server's flag", () => {
    expect(PGV).toMatch(/const freeModel = core\.free;/);
  });

  it("pays with the current boost and quality, not the first render's", () => {
    const deps = PGV.slice(PGV.indexOf("}, [isFree, core, boost, quality,"));
    expect(deps.startsWith("}, [isFree, core, boost, quality,")).toBe(true);
  });
});
