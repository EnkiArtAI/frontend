import { describe, it, expect } from "vitest";
import {
  generateBlock, editorSetup, editorRequest, readyRefs, renderSettings, nameIssue,
  type GenerateInput, type GenerateCheck, type RenderPicks,
} from "../generate-checks";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { GenerationQuote } from "@/lib/generation-checkout";
import { REFS_LOADING } from "@/hooks/useReferenceReads";
import { REFS_TOO_LARGE } from "@/lib/request-size";

const model = (o: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  id: "m-pro", name: "Nano Banana Pro", price: 0.1, mediaType: "image", supportsQuality: false, maxResolution: "4K",
  ratios: ["1:1", "4:5", "16:9"], boostAvailable: true, boostTiers: ["2K", "4K"], maxRefs: 14, free: false, ...o,
});
const quote = (totalMicro: number): GenerationQuote => ({
  totalMicro, totalUsd: (totalMicro / 1e6).toFixed(3), networkFeeUsd: "0.001", artistUsd: "0.00", expiresAt: "", appliedRule: null,
});
const DATA = "data:image/webp;base64,AAAA";
const picks: RenderPicks = { ratio: "4:5", resolution: "2K", quality: "medium", boost: false };

const ok: GenerateInput = {
  doc: { prompt: "a [subject] by [Reference image 1]", vars: { subject: "cat", gone: "kept" }, kinds: {}, refIds: ["r1"] },
  refs: { r1: { data: DATA, stored: null, state: "ready" } },
  reading: false,
  signedIn: true,
  entry: model(),
  picks,
  quote: quote(120_000),
  wallet: true,
  balanceUsd: 1,
};

/** One way to fail each check, in the plan's order; each leaves every other check as it was. */
const breaks: Array<[GenerateCheck, (i: GenerateInput) => GenerateInput]> = [
  ["prompt", (i) => ({ ...i, doc: { ...i.doc, prompt: "  \n " } })],
  ["login", (i) => ({ ...i, signedIn: false })],
  ["generator", (i) => ({ ...i, entry: undefined })],
  ["names", (i) => ({ ...i, doc: { ...i.doc, prompt: `${i.doc.prompt} []` } })],
  ["values", (i) => ({ ...i, doc: { ...i.doc, vars: { ...i.doc.vars, subject: " " } } })],
  ["refs-ready", (i) => ({ ...i, reading: true })],
  ["refs-missing", (i) => ({ ...i, doc: { ...i.doc, prompt: `${i.doc.prompt} [Reference image 2]` } })],
  ["refs-free", (i) => ({ ...i, entry: i.entry && { ...i.entry, free: true } })],
  ["refs-max", (i) => ({ ...i, entry: i.entry && { ...i.entry, maxRefs: 0 } })],
  ["price", (i) => ({ ...i, quote: null })],
  ["wallet", (i) => ({ ...i, wallet: false })],
  ["funds", (i) => ({ ...i, balanceUsd: 0.1 })],
  ["size", (i) => ({ ...i, refs: { r1: { data: `${DATA}${"A".repeat(4_000_000)}`, stored: null, state: "ready" } } })],
];

describe("generateBlock", () => {
  it("lets a complete render through", () => {
    expect(generateBlock(ok)).toBeNull();
  });

  it.each(breaks.map(([check, br], k) => [check, br, k] as const))("%s fails alone", (check, br) => {
    expect(generateBlock(br(ok))?.check).toBe(check);
  });

  it.each(breaks.map(([check], k) => [check, k] as const))("%s comes before every later check", (check, k) => {
    const input = breaks.slice(k).reverse().reduce((i, [, br]) => br(i), ok);
    expect(generateBlock(input)?.check).toBe(check);
  });

  it("says what the surface does for each check", () => {
    const run = (k: number) => generateBlock(breaks[k][1](ok));
    expect(run(0)).toEqual({ check: "prompt", toast: "Write a prompt first" });
    expect(run(1)).toEqual({ check: "login", open: "login" });
    expect(run(2)).toEqual({ check: "generator", toast: "Pick a generator", open: "primary" });
    expect(run(3)).toEqual({ check: "names", toast: "Name every variable first", focus: { variable: "" } });
    expect(run(4)).toEqual({ check: "values", toast: "Fill in [subject] first", focus: { variable: "subject" } });
    expect(run(5)).toEqual({ check: "refs-ready", toast: REFS_LOADING });
    expect(run(6)).toEqual({ check: "refs-missing", toast: "[Reference image 2] has no image · upload it or remove the token" });
    expect(run(7)).toEqual({ check: "refs-free", toast: "Nano Banana Pro takes no reference images · pick another generator or remove them" });
    expect(run(8)).toEqual({ check: "refs-max", toast: "Nano Banana Pro takes up to 0 reference images" });
    expect(run(9)).toEqual({ check: "price", toast: "Getting the price…" });
    expect(run(10)).toEqual({ check: "wallet", open: "wallet" });
    expect(run(11)).toEqual({ check: "funds", open: "add-funds" });
    expect(run(12)).toEqual({ check: "size", toast: REFS_TOO_LARGE });
  });

  it("blocks every name the save could not store (R19), and an empty checkbox text too", () => {
    const withPrompt = (prompt: string, vars: Record<string, string> = {}) =>
      generateBlock({ ...ok, doc: { ...ok.doc, prompt: `${prompt} [Reference image 1]`, vars, kinds: { tick: "checkbox" } } });
    expect(withPrompt("[猫]", { 猫: "cat" })).toEqual({ check: "names", toast: "[猫] needs a letter a–z or a digit to be saved", focus: { variable: "猫" } });
    expect(withPrompt("[Cat] [cat]", { Cat: "a", cat: "b" })).toEqual({
      check: "names", toast: "[Cat] and [cat] would be saved under one name · rename one", focus: { variable: "cat" },
    });
    expect(withPrompt("[tick]", { tick: "" })?.focus).toEqual({ variable: "tick" });
  });

  it("waits for a stored reference still being read, and refuses one that failed or is gone", () => {
    const refs = (r1: GenerateInput["refs"][string] | undefined) => generateBlock({ ...ok, refs: r1 ? { r1 } : {} });
    expect(refs({ data: null, stored: "https://x/r.webp", state: "loading" })?.toast).toBe(REFS_LOADING);
    const failed = "A reference image couldn't be loaded · upload it again";
    expect(refs({ data: null, stored: "https://x/r.webp", state: "failed" })).toEqual({ check: "refs-ready", toast: failed });
    expect(refs(undefined)).toEqual({ check: "refs-ready", toast: failed });
  });

  it("knows [Reference image 0] has no image", () => {
    expect(generateBlock({ ...ok, doc: { ...ok.doc, prompt: `${ok.doc.prompt} [Reference image 0]` } })?.check).toBe("refs-missing");
  });

  it("caps references at 14, the most a prompt can be saved with, whatever the model takes", () => {
    const many = Array.from({ length: 15 }, (_, n) => `r${n}`);
    const input = { ...ok, entry: model({ maxRefs: 20 }), doc: { ...ok.doc, refIds: many }, refs: Object.fromEntries(many.map((id) => [id, ok.refs.r1])) };
    expect(generateBlock(input)?.toast).toBe("Nano Banana Pro takes up to 14 reference images");
    const unknown = { ...input, entry: model({ maxRefs: undefined }) };
    expect(generateBlock(unknown)?.toast).toBe("Nano Banana Pro takes up to 14 reference images");
    expect(generateBlock({ ...unknown, doc: { ...input.doc, refIds: many.slice(1) } })).toBeNull();
  });

  it("lets a low balance through after Try anyway, and never checks an unknown one", () => {
    expect(generateBlock({ ...ok, balanceUsd: 0.1, lowBalanceOk: true })).toBeNull();
    expect(generateBlock({ ...ok, balanceUsd: null })).toBeNull();
    expect(generateBlock({ ...ok, balanceUsd: 0.12 })).toBeNull();
  });

  it("asks a free model for no price, wallet or balance", () => {
    const free = { ...ok, entry: model({ free: true }), doc: { ...ok.doc, prompt: "a [subject]", refIds: [] } };
    expect(generateBlock({ ...free, quote: null, wallet: false, balanceUsd: 0 })).toBeNull();
  });
});

describe("the job and its request", () => {
  it("a setup holds the text's own variables only, and the model's settings", () => {
    const s = editorSetup({ ...ok.doc, kinds: { subject: "checkbox" } }, model({ supportsQuality: true }), { ratio: "3:2", resolution: "4K", quality: "high", boost: true });
    expect(s).toEqual({
      prompt: ok.doc.prompt, vars: { subject: "cat" }, kinds: { subject: "checkbox" }, refIds: ["r1"],
      modelId: "m-pro", modelName: "Nano Banana Pro", ratio: "1:1", resolution: "4K", quality: "high", boost: true,
    });
    expect(editorSetup({ ...ok.doc, prompt: "[a] [b]", vars: { a: "1" } }, model(), picks)).toMatchObject({ vars: { a: "1", b: "" }, kinds: { a: "text", b: "text" } });
  });

  it("renders as the model can: tier, ratio, quality and boost (per tier, and only where a faster host exists)", () => {
    const nb2 = model({ maxResolution: "2K", boostTiers: ["2K"] });
    expect(renderSettings(nb2, { ratio: "4:5", resolution: "4K", quality: "high", boost: true })).toEqual({ ratio: "4:5", resolution: "2K", quality: undefined, boost: true });
    expect(renderSettings(nb2, { ratio: "4:5", resolution: "1K", boost: true }).boost).toBe(false);
    expect(renderSettings(model({ boostAvailable: false, boostTiers: ["2K"] }), { ...picks, boost: true }).boost).toBe(false);
    expect(renderSettings(model(), { ...picks, boost: false }).boost).toBe(false);
  });

  it("the request is the artist's own draft: authoring, no promptId, the text filled, the references in order", () => {
    const setup = editorSetup(ok.doc, model(), picks);
    const r = editorRequest(setup, [model({ id: "other" }), model()], ["d1"]);
    expect(r).toEqual({
      model: model(), resolution: "2K", quality: undefined, boost: false, prompt: "a cat by Reference image 1",
      aspectRatio: "4:5", referenceImages: ["d1"], authoring: true,
    });
    expect(r).not.toHaveProperty("promptId");
    expect(editorRequest(setup, [model({ id: "other" })], []).model).toBeUndefined();
    expect(editorRequest(setup, [model()], []).referenceImages).toBeUndefined();
  });

  it("readyRefs: the data in order, or null while any is not read in", () => {
    const refs = { a: { data: "da", stored: null, state: "ready" as const }, b: { data: "db", stored: "https://b", state: "ready" as const } };
    expect(readyRefs(refs, ["b", "a"])).toEqual(["db", "da"]);
    expect(readyRefs({ ...refs, b: { data: null, stored: "https://b", state: "loading" } }, ["a", "b"])).toBeNull();
    expect(readyRefs(refs, ["a", "c"])).toBeNull();
    expect(readyRefs({ a: { data: "stale", stored: "https://a", state: "failed" } }, ["a"])).toBeNull();
  });

  it("nameIssue agrees with the save route's slugs", () => {
    expect(nameIssue(["red car", "red-car"])?.message).toBe("[red car] and [red-car] would be saved under one name · rename one");
    expect(nameIssue(["2nd", "v 2nd"])?.name).toBe("v 2nd");
    expect(nameIssue(["cat", "dog"])).toBeNull();
  });
});
