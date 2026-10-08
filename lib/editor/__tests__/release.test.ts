import { describe, it, expect } from "vitest";
import { releaseBlock, releaseBody, listingOnly, updateBody, type Listing, type ReleaseCheck, type Saved } from "../release";
import type { EditorSetup } from "../generate-checks";
import type { EditorDoc, RefStore } from "../undo";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { Job } from "@/lib/ui/kit/render-queue";
import { SAVE_TOO_LARGE } from "@/lib/request-size";

type J = Job<EditorSetup>;
const primary: CatalogueEntry = {
  id: "m-pro", name: "Nano Banana Pro", price: 0.1, mediaType: "image", supportsQuality: false, maxResolution: "4K", ratios: ["1:1"], free: false,
};
const PROMPT = "a [subject] in [light] by [Reference image 1]";
const setup = (vars: Record<string, string>, o: Partial<EditorSetup> = {}): EditorSetup => ({
  prompt: PROMPT, vars, kinds: { light: "checkbox" }, refIds: ["new", "kept"],
  modelId: "m-pro", modelName: "Nano Banana Pro", ratio: "4:5", resolution: "2K", boost: false, ...o,
});
const job = (id: string, s: EditorSetup): J => ({ id, createdAt: 1, status: "ready", imageUrl: `https://x/${id}.webp`, seen: true, setup: s });
const starred: J[] = [
  job("s1", setup({ subject: "fox", light: "dusk light" })),
  job("s2", setup({ subject: "owl", light: "dawn" }, { ratio: "1:1", resolution: "4K" })),
  job("s3", setup({ subject: "elk", light: "noon" })),
  job("s4", setup({ subject: "cat", light: "night" })),
];
const listing: Listing = { title: "  Dusk portrait ", mode: "premium", price: 0.4, category: "Portrait", primaryId: "m-pro", testId: null };
const refs: RefStore = {
  new: { data: "data:image/webp;base64,NEW", stored: null, state: "ready" },
  kept: { data: "data:image/webp;base64,OLD", stored: "https://blob/kept.webp", state: "ready" },
};

type In = Parameters<typeof releaseBlock>[0];
const ok: In = { listing, primary, starred, busy: false };
const cover = (i: In, vars: Record<string, string>, prompt = PROMPT): J[] => [job("s1", { ...i.starred[0].setup, vars, prompt }), ...i.starred.slice(1)];

/** One way to fail each check, in order; each leaves the others as they were. */
const breaks: Array<[ReleaseCheck, (i: In) => In]> = [
  ["stars", (i) => ({ ...i, starred: i.starred.slice(0, 3) })],
  ["primary", (i) => ({ ...i, primary: undefined })],
  ["model", (i) => ({ ...i, starred: i.starred.map((j, k) => (k === 1 ? job(j.id, { ...j.setup, modelId: "m-gpt", modelName: "GPT Image" }) : j)) })],
  ["title", (i) => ({ ...i, listing: { ...i.listing, title: " " } })],
  ["category", (i) => ({ ...i, listing: { ...i.listing, category: null } })],
  ["price", (i) => ({ ...i, listing: { ...i.listing, price: 0.004 } })],
  ["names", (i) => ({ ...i, starred: cover(i, i.starred[0].setup.vars, `${PROMPT} []`) })],
  ["values", (i) => ({ ...i, starred: cover(i, { ...i.starred[0].setup.vars, light: "  " }) })],
  ["busy", (i) => ({ ...i, busy: true })],
];

describe("releaseBlock", () => {
  it("lets a complete release go", () => {
    expect(releaseBlock(ok)).toBeNull();
  });

  it.each(breaks.map(([check, br]) => [check, br] as const))("%s fails alone", (check, br) => {
    expect(releaseBlock(br(ok))?.check).toBe(check);
  });

  it.each(breaks.map(([check], k) => [check, k] as const))("%s comes before every later check", (check, k) => {
    expect(releaseBlock(breaks.slice(k).reverse().reduce((i, [, br]) => br(i), ok))?.check).toBe(check);
  });

  it("says why, and what to focus or open", () => {
    const run = (k: number) => releaseBlock(breaks[k][1](ok));
    expect(run(0)).toEqual({ check: "stars", message: "Star 1 more image from one variation" });
    expect(releaseBlock({ ...ok, starred: [] })?.message).toBe("Star 4 more images from one variation");
    expect(run(1)).toEqual({ check: "primary", message: "Pick the generator this prompt is made for", open: "primary" });
    expect(run(2)).toEqual({
      check: "model",
      message: "1 starred image was made with GPT Image — your primary generator is Nano Banana Pro. Star images from Nano Banana Pro, or make GPT Image primary",
    });
    expect(run(3)).toEqual({ check: "title", message: "Give your prompt a title", focus: "title" });
    expect(run(4)).toEqual({ check: "category", message: "Pick a category", open: "category" });
    expect(run(5)).toEqual({ check: "price", message: "Set a price of at least $0.01", focus: "price" });
    expect(run(6)).toEqual({ check: "names", message: "Name every variable first", focus: { variable: "" } });
    expect(run(7)).toEqual({ check: "values", message: "Every variable needs a value — [light] is empty", focus: { variable: "light" } });
    expect(run(8)).toEqual({ check: "busy", message: null });
  });

  it("counts every starred render from another generator", () => {
    const two = starred.map((j, k) => (k % 2 ? job(j.id, { ...j.setup, modelId: "m-gpt", modelName: "GPT Image" }) : j));
    expect(releaseBlock({ ...ok, starred: two })?.message).toMatch(/^2 starred images were made with GPT Image — /);
  });

  it("asks Free for one star and no price; a price rounding to a cent is enough", () => {
    expect(releaseBlock({ ...ok, listing: { ...listing, mode: "free", price: 0 }, starred: starred.slice(0, 1) })).toBeNull();
    expect(releaseBlock({ ...ok, listing: { ...listing, price: 0.005 } })).toBeNull();
  });

  it("checks the cover's names by the save's slugs (R19)", () => {
    expect(releaseBlock({ ...ok, starred: cover(ok, { cat: "1", Cat: "2" }, "[cat] [Cat]") })?.focus).toEqual({ variable: "Cat" });
    expect(releaseBlock({ ...ok, starred: cover(ok, { 猫: "1" }, "[猫]") })?.check).toBe("names");
  });

  it("a listing-only update needs no stars and checks the loaded text instead", () => {
    const loaded = { prompt: "a [subject]", vars: { subject: "fox" } };
    expect(releaseBlock({ ...ok, starred: [], loaded })).toBeNull();
    expect(releaseBlock({ ...ok, starred: [], loaded: { ...loaded, vars: {} } })?.check).toBe("values");
    expect(releaseBlock({ ...ok, starred: [], loaded: { ...loaded, prompt: "[猫]" } })?.check).toBe("names");
  });
});

describe("releaseBody", () => {
  const body = (o: Partial<Parameters<typeof releaseBody>[0]> = {}) => {
    const r = releaseBody({ listing, primary, starred, refs, ...o });
    if (!("body" in r)) throw new Error(r.error);
    return r.body;
  };

  it("is the first starred render's text, values, references, ratio and resolution, with the listing", () => {
    expect(body()).toEqual({
      release: true,
      title: "Dusk portrait",
      content: "a [subject] in [light] by Reference image 1",
      promptType: "premium-prompt",
      aiModel: "Nano Banana Pro",
      category: "Portrait",
      price: 0.4,
      variables: [
        { name: "subject", label: "subject", description: "", type: "text", defaultValue: "fox", required: true, position: 0 },
        { name: "light", label: "dusk light", description: "dusk light", type: "checkbox", defaultValue: true, required: false, position: 1 },
      ],
      referenceImages: ["data:image/webp;base64,NEW", "https://blob/kept.webp"],
      uploadedPhotos: ["https://x/s1.webp", "https://x/s2.webp", "https://x/s3.webp", "https://x/s4.webp"],
      aspectRatio: "4:5",
      resolution: "2K",
    });
  });

  it("names the prompt to update, and sends no id on the first release", () => {
    expect(body({ id: "0b5f6c1e-1111-4222-8333-944445555666" }).id).toBe("0b5f6c1e-1111-4222-8333-944445555666");
    expect(JSON.parse(JSON.stringify(body()))).not.toHaveProperty("id");
  });

  it("shows the starred renders in star order, https only, at most four", () => {
    const five = [...starred, job("s5", starred[0].setup)];
    expect(body({ starred: five }).uploadedPhotos).toEqual(["https://x/s1.webp", "https://x/s2.webp", "https://x/s3.webp", "https://x/s4.webp"]);
    const mixed = [starred[2], { ...starred[0], imageUrl: "data:image/png;base64,AA" }, starred[1]];
    expect(body({ starred: mixed }).uploadedPhotos).toEqual(["https://x/s3.webp", "https://x/s2.webp"]);
  });

  it("releases Free at price 0 with one image", () => {
    const free = body({ listing: { ...listing, mode: "free" } });
    expect([free.promptType, free.price, free.uploadedPhotos]).toEqual(["free-prompt", 0, ["https://x/s1.webp"]]);
  });

  it("refuses a body too large to arrive, and a reference that is gone", () => {
    const huge = { ...refs, new: { data: `data:image/webp;base64,${"A".repeat(4_000_000)}`, stored: null, state: "ready" as const } };
    expect(releaseBody({ listing, primary, starred, refs: huge })).toEqual({ error: SAVE_TOO_LARGE });
    expect(releaseBody({ listing, primary, starred, refs: { kept: refs.kept } })).toEqual({
      error: "A reference image of the starred render is gone · upload it again and render once more",
    });
  });
});

describe("listing-only update", () => {
  const doc: EditorDoc = { prompt: "a [subject]", vars: { subject: "fox", gone: "x" }, kinds: {}, aiNames: ["subject"], refIds: ["https://blob/r1.webp"] };

  it("is a loaded prompt untouched in text, values, kinds and references, with nothing starred", () => {
    expect(listingOnly({ ...doc, vars: { subject: "fox" }, aiNames: [] }, doc, 0)).toBe(true);
    expect(listingOnly(doc, doc, 1)).toBe(false);
    expect(listingOnly({ ...doc, prompt: "a [subject]!" }, doc, 0)).toBe(false);
    expect(listingOnly({ ...doc, vars: { subject: "owl" } }, doc, 0)).toBe(false);
    expect(listingOnly({ ...doc, kinds: { subject: "checkbox" } }, doc, 0)).toBe(false);
    expect(listingOnly({ ...doc, refIds: [] }, doc, 0)).toBe(false);
  });

  it("sends the prompt back exactly as it was loaded, under the new listing", () => {
    const saved: Saved = {
      content: "a [Red car] by Reference image 1",
      variables: [{ name: "Red car", label: "Red car", description: "", type: "slider", defaultValue: 3, required: true, position: 0, min: 0, max: 5, options: null }],
      referenceImages: ["https://blob/r1.webp"],
      uploadedPhotos: ["https://blob/s1.webp"],
      aspectRatio: "3:2",
      resolution: null,
    };
    expect(updateBody({ listing: { ...listing, mode: "free" }, primary, saved, id: "pid" })).toEqual({
      release: true, id: "pid", title: "Dusk portrait", promptType: "free-prompt", aiModel: "Nano Banana Pro", category: "Portrait", price: 0, ...saved,
    });
  });
});
