import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { resolveCatalogueEntry, type CatalogueEntry } from "@/hooks/useModelLimits";

/**
 * Editor 2 generates the model the user picked, or nothing.
 *
 * A missed lookup used to downgrade silently: generateWithModel read
 * `isFree = !model || model.price <= 0`, so a null model went to the free
 * route and Flux rendered for a user who had picked GPT-Image-2. Drafts carry
 * the model as a slug while the catalogue keys by UUID, so the miss was easy
 * to hit. Now an unresolved selection blocks Generate, and the editor starts
 * with no model at all rather than a hardcoded one.
 */

const ROOT = join(__dirname, "..", "..");
const NODE = readSource(join(ROOT, "components", "enki-shell", "NodeCreator.tsx"));

const CAT: CatalogueEntry[] = [
  { id: "db00c518-uuid", name: "Nano Banana Pro", price: 0.14, mediaType: "image" as const, supportsQuality: false, maxResolution: "4K", ratios: ["1:1"], free: false },
  { id: "14b3db65-uuid", name: "GPT-Image-2", price: 0.17, mediaType: "image" as const, supportsQuality: true, maxResolution: "4K", ratios: ["1:1"], free: false },
];

describe("Editor 2 generates the selected model or nothing", () => {
  it("resolves the selection the same way the pickers do", () => {
    expect(NODE).toMatch(/const picked = resolveCatalogueEntry\(catalogueRef\.current, stRef\.current\.models\[0\]\);/);
    expect(resolveCatalogueEntry(CAT, "nano-banana-pro")?.name).toBe("Nano Banana Pro");
  });

  it("sends through runGeneration, which refuses an unresolved model", () => {
    expect(NODE).toMatch(/await runGeneration\(\n\s+\{\n\s+model: picked,/);
    expect(NODE).not.toMatch(/generateWithModel|isFree = !model/);
  });

  it("cannot start without a resolved model", () => {
    expect(NODE).toMatch(/const canGenerate = st\.body\.trim\(\)\.length > 0 && !!selectedModel;/);
    expect(NODE.match(/onToast\("Pick a model first"\); return; \}/g)?.length).toBe(2);
  });

  it("starts with no model rather than a hardcoded one, and shows the selection only", () => {
    expect(NODE).not.toMatch(/models: \["nano-banana-pro"\]/);
    expect(NODE).not.toMatch(/\|\| catalogue\[0\]/);
  });

  it("leaves a failed slot empty instead of showing a placeholder as a finished image", () => {
    expect(NODE).toMatch(/if \(!outcome\.ok\) \{[\s\S]{0,400}img: null, status: "empty"/);
    expect(NODE).not.toMatch(/placeholderArt\("fallback"/);
  });
});
