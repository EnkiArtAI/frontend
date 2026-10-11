import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import { defaultModel } from "@/lib/ui/image-view/models";
import { makeSetup, quoteOf, toRequest, type Composer } from "@/lib/ui/image-view/setups";
const model: CatalogueEntry = { id: "artist-model", name: "Artist model", price: 0.1, free: false, mediaType: "image", supportsQuality: true, maxResolution: "4K", ratios: ["1:1"], boostAvailable: true, boostTiers: ["4K"] };
const catalogue = [model];
const composer: Composer = { promptId: "prompt", publicText: "a fox", edited: null, variables: [], values: {}, model, resolution: "4K", aspectRatio: "1:1", quality: "high", boost: true, refs: ["data:image/png;base64,AA=="] };
describe("the current marketplace model selection", () => {
  it("preselects the artist model only when offered, and the buyer pick wins", () => {
    expect(defaultModel({ catalogue, pick: "", aiModel: model.id, premium: true })).toBe(model.name);
    expect(defaultModel({ catalogue, pick: "Buyer pick", aiModel: model.id, premium: true })).toBe("Buyer pick");
    expect(defaultModel({ catalogue: [], pick: "", aiModel: model.id, premium: true })).toBe("");
    expect(defaultModel({ catalogue: [{ ...model, free: true }], pick: "", aiModel: model.id, premium: true })).toBe("");
  });
  it("sends the selected model, prompt and current settings through the shared queue", () => {
    const setup = makeSetup(composer)!;
    expect(toRequest(setup)).toMatchObject({ model, promptId: "prompt", quality: "high", boost: true, referenceImages: composer.refs });
    expect(quoteOf(setup)).toMatchObject({ entry: model, promptId: "prompt", quality: "high", boost: true, referenceImageCount: 1 });
    expect(makeSetup({ ...composer, model: undefined })).toBeNull();
  });
  it("uses the server free flag and disables boost at a size without a faster host", () => {
    expect(makeSetup({ ...composer, resolution: "1K" })?.boost).toBe(false);
    const free = { ...model, price: 0.1, free: true };
    expect(toRequest(makeSetup({ ...composer, model: free })!).model?.free).toBe(true);
  });
  it("never resets a pick as the catalogue loads", () => {
    const view = readSource(join(__dirname, "..", "..", "components", "image-view", "useImageViewModel.ts"));
    expect(view).toContain('const [pick, setPick] = useState("");');
    expect(view).toContain('defaultModel({ catalogue, pick, aiModel: prompt?.ai_model, premium })');
    expect(view).not.toMatch(/setPick\(catalogue\[0\]/);
  });
});
