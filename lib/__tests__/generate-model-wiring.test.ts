import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { resolveCatalogueEntry, type CatalogueEntry } from "@/hooks/useModelLimits";

/**
 * A missed model lookup does not throw here — it silently downgrades the whole
 * generation.
 *
 * generateWithModel derives `const isFree = !model || model.price <= 0`, so a
 * null model routes to /api/generate-free (Flux) and drops modelIds, boost AND
 * quality with it. The user picks GPT-Image-2, sees its price, and receives a
 * free Flux image. Drafts carry the model as a slug while the catalogue keys by
 * UUID, so an exact-id find at the call site produced exactly that.
 */

const ROOT = join(__dirname, "..", "..");
const NODE = readSource(join(ROOT, "components", "enki-shell", "NodeCreator.tsx"));
const GEN = readSource(join(ROOT, "components", "enki-shell", "generation.ts"));

const CAT: CatalogueEntry[] = [
  { id: "db00c518-uuid", name: "Nano Banana Pro", price: 0.14, mediaType: "image" as const, supportsQuality: false, maxResolution: "4K", ratios: ["1:1"] },
  { id: "14b3db65-uuid", name: "GPT-Image-2", price: 0.17, mediaType: "image" as const, supportsQuality: true, maxResolution: "4K", ratios: ["1:1"] },
];

describe("the generate call resolves the model the same way the pickers do", () => {
  it("uses resolveCatalogueEntry, not an exact-id find", () => {
    expect(NODE).toMatch(/picked = resolveCatalogueEntry\(catalogueRef\.current, stRef\.current\.models\[0\]\)/);
    expect(NODE).not.toMatch(/catalogueRef\.current\.find\(\(m\) => m\.id ===/);
  });

  it("a slug-carrying draft still resolves to the PAID model", () => {
    // The live-bug input: st.models starts as ["nano-banana-pro"].
    const picked = resolveCatalogueEntry(CAT, "nano-banana-pro");
    expect(picked).toBeDefined();
    expect(picked!.price).toBeGreaterThan(0);
    // which is what keeps isFree false in generateWithModel
    expect(!picked || picked.price <= 0).toBe(false);
  });

  it("an unresolved model would silently go free — the reason this matters", () => {
    // Pins the downgrade rule itself, so a future edit to generation.ts that
    // changes it cannot pass unnoticed.
    expect(GEN).toMatch(/const isFree = !model \|\| model\.price <= 0/);
    const unresolved = resolveCatalogueEntry(CAT, "some-draft-slug-nobody-has");
    expect(!unresolved || unresolved.price <= 0).toBe(true);
  });

  it("quality only travels on the PAID branch, so a downgrade drops it too", () => {
    expect(GEN).toMatch(/body: JSON\.stringify\(\{ prompt, aspectRatio, resolution, workflow \}\)/);
    expect(GEN).toMatch(/body: JSON\.stringify\(\{ intentId, prompt, aspectRatio, workflow, modelIds: \[model\.id\], boost: !!boost, quality \}\)/);
  });
});
