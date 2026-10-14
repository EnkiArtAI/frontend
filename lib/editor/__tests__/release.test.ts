import { describe, it, expect } from "vitest";
import { releaseBlock, releaseBody, listingOnly, storedRefs, updateBody, type Listing, type ReleaseCheck, type Saved } from "../release";
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
const gpt: CatalogueEntry = { ...primary, id: "m-gpt", name: "GPT Image" };
const catalogue = [primary, gpt];
const listing: Listing = { title: "  Dusk portrait ", mode: "premium", price: 0.4, category: "Portrait", modelIds: ["m-pro"], testId: null };
const refs: RefStore = {
  new: { data: "data:image/webp;base64,NEW", stored: null, state: "ready" },
  kept: { data: "data:image/webp;base64,OLD", stored: "https://blob/kept.webp", state: "ready" },
};

type In = Parameters<typeof releaseBlock>[0];
const ok: In = { listing, starred, busy: false };
const cover = (i: In, vars: Record<string, string>, prompt = PROMPT): J[] => [job("s1", { ...i.starred[0].setup, vars, prompt }), ...i.starred.slice(1)];

/** One way to fail each check, in order; each leaves the others as they were. */
const breaks: Array<[ReleaseCheck, (i: In) => In]> = [
  ["stars", (i) => ({ ...i, starred: i.starred.slice(0, 3) })],
  ["offer", (i) => ({ ...i, listing: { ...i.listing, modelIds: [] } })],
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
    expect(run(1)).toEqual({ check: "offer", message: "Pick the generators this prompt offers", open: "offer" });
    expect(run(2)).toEqual({
      check: "model",
      message: "1 starred image was made with GPT Image, which is not on offer — put GPT Image on offer, or star images from an offered generator",
      open: "offer",
    });
    expect(run(3)).toEqual({ check: "title", message: "Give your prompt a title", focus: "title" });
    expect(run(4)).toEqual({ check: "category", message: "Pick a category", open: "category" });
    expect(run(5)).toEqual({ check: "price", message: "Set a price of at least $0.01", focus: "price" });
    expect(run(6)).toEqual({ check: "names", message: "Name every variable first", focus: { variable: "" } });
    expect(run(7)).toEqual({ check: "values", message: "Every variable needs a value — [light] is empty", focus: { variable: "light" } });
    expect(run(8)).toEqual({ check: "busy", message: null });
  });

  it("counts every starred render from a generator not on offer, and takes any mix of offered ones (no primary)", () => {
    const two = starred.map((j, k) => (k % 2 ? job(j.id, { ...j.setup, modelId: "m-gpt", modelName: "GPT Image" }) : j));
    expect(releaseBlock({ ...ok, starred: two })?.message).toMatch(/^2 starred images were made with GPT Image, which is not on offer — /);
    expect(releaseBlock({ ...ok, listing: { ...listing, modelIds: ["m-pro", "m-gpt"] }, starred: two })).toBeNull();
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
    const r = releaseBody({ listing, starred, refs, catalogue, ...o });
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
      aiModels: ["Nano Banana Pro"],
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

  it("names the cover's references it sends, in its order", () => {
    const r = releaseBody({ listing, starred: [job("s1", setup({ subject: "fox", light: "dusk" }, { refIds: ["kept"] })), ...starred.slice(1)], refs, catalogue });
    expect(r).toMatchObject({ refIds: ["kept"], body: { referenceImages: ["https://blob/kept.webp"] } });
    expect(releaseBody({ listing, starred, refs, catalogue })).toMatchObject({ refIds: ["new", "kept"] });
  });

  it("names the cover's generator as the prompt's own, then every generator on offer by catalogue name, each once; an id the catalogue lost is dropped", () => {
    const gptCover = [job("s1", setup({ subject: "fox", light: "dusk" }, { modelId: "m-gpt", modelName: "GPT Image" })), ...starred.slice(1)];
    expect(body({ listing: { ...listing, modelIds: ["m-pro", "m-gpt"] }, starred: gptCover })).toMatchObject({ aiModel: "GPT Image", aiModels: ["GPT Image", "Nano Banana Pro"] });
    expect(body({ listing: { ...listing, modelIds: ["m-pro", "m-gone", "m-gpt"] } }).aiModels).toEqual(["Nano Banana Pro", "GPT Image"]);
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
    expect(releaseBody({ listing, starred, refs: huge, catalogue })).toEqual({ error: SAVE_TOO_LARGE });
    expect(releaseBody({ listing, starred, refs: { kept: refs.kept }, catalogue })).toEqual({
      error: "A reference image of the starred render is gone · upload it again and render once more",
    });
  });
});

describe("storedRefs", () => {
  it("is where the server stored each reference sent, by ref id, in the order sent", () => {
    expect(storedRefs(["new", "kept"], ["https://blob/new.webp", "https://blob/kept.webp"])).toEqual({
      new: "https://blob/new.webp", kept: "https://blob/kept.webp",
    });
  });

  it("is nothing for an answer that does not line up with what was sent", () => {
    expect(storedRefs(["a", "b"], ["https://blob/a.webp"])).toEqual({});
    expect(storedRefs(["a"], ["https://blob/a.webp", "https://blob/b.webp"])).toEqual({});
    expect(storedRefs(["a"], undefined)).toEqual({});
    expect(storedRefs(["a"], { 0: "https://blob/a.webp", length: 1 })).toEqual({});
    expect(storedRefs(["a", "b"], ["https://blob/a.webp", "data:image/webp;base64,AA"])).toEqual({});
    expect(storedRefs(["a", "b"], [7, "https://blob/b.webp"])).toEqual({});
  });
});

describe("listing-only update", () => {
  const doc: EditorDoc = { prompt: "a [subject]", vars: { subject: "fox", gone: "x" }, kinds: {}, aiNames: ["subject"], refIds: ["https://blob/r1.webp"] };
  const live: Saved = { content: "a [subject]", variables: [], referenceImages: ["https://blob/r1.webp"], uploadedPhotos: ["https://blob/s1.webp"], aspectRatio: "4:5", resolution: "2K", aiModel: "Nano Banana Pro" };
  /** A released Free prompt with its one live image, made with Nano Banana Pro. */
  const loaded: { doc: EditorDoc; listing: Listing; saved: Saved } = { doc, listing: { ...listing, mode: "free" }, saved: live };
  const only = (patch: Partial<Listing>, from = loaded, d = doc) => listingOnly(d, { ...from.listing, ...patch }, from, 0);

  it("is a loaded prompt untouched in text, values, kinds and references, with nothing starred", () => {
    expect(listingOnly({ ...doc, vars: { subject: "fox" }, aiNames: [] }, loaded.listing, loaded, 0)).toBe(true);
    expect(listingOnly(doc, loaded.listing, loaded, 1)).toBe(false);
    expect(only({}, loaded, { ...doc, prompt: "a [subject]!" })).toBe(false);
    expect(only({}, loaded, { ...doc, vars: { subject: "owl" } })).toBe(false);
    expect(only({}, loaded, { ...doc, kinds: { subject: "checkbox" } })).toBe(false);
    expect(only({}, loaded, { ...doc, refIds: [] })).toBe(false);
    expect(only({ title: "Owl portrait", price: 0.9, category: "Animals" })).toBe(true);
  });

  it("may change the generators on offer: no render depends on them (no primary, Kev 2026-10-13)", () => {
    expect(only({ modelIds: ["m-pro", "m-gpt"] })).toBe(true);
    expect(only({ modelIds: ["m-gpt"] })).toBe(true);
  });

  it("switches mode only with as many live images as the new mode shows", () => {
    expect(only({ mode: "premium" })).toBe(false);
    const four = { ...loaded, saved: { ...live, uploadedPhotos: ["https://b/1", "https://b/2", "https://b/3", "https://b/4"] } };
    expect(only({ mode: "premium" }, four)).toBe(true);
    // Premium to Free keeps one of four; a mode left as it is stays as it was saved.
    const premium = { ...loaded, listing: { ...loaded.listing, mode: "premium" as const } };
    expect(only({ mode: "free" }, { ...four, listing: premium.listing })).toBe(true);
    expect(only({ price: 0.5 }, premium)).toBe(true);
    // And the release then asks for the missing stars.
    expect(releaseBlock({ listing: { ...loaded.listing, mode: "premium" }, starred: [], busy: false, loaded: null })?.message)
      .toBe("Star 4 more images from one variation");
  });

  it("sends the prompt back exactly as it was loaded, under the new listing", () => {
    const saved: Saved = {
      content: "a [Red car] by Reference image 1",
      variables: [{ name: "Red car", label: "Red car", description: "", type: "slider", defaultValue: 3, required: true, position: 0, min: 0, max: 5, options: null }],
      referenceImages: ["https://blob/r1.webp"],
      uploadedPhotos: ["https://blob/s1.webp"],
      aspectRatio: "3:2",
      resolution: null,
      aiModel: "Nano Banana Pro",
    };
    expect(updateBody({ listing: { ...listing, mode: "free", modelIds: ["m-pro", "m-gpt"] }, saved, id: "pid", catalogue })).toEqual({
      release: true, id: "pid", title: "Dusk portrait", promptType: "free-prompt", aiModels: ["Nano Banana Pro", "GPT Image"],
      category: "Portrait", price: 0, ...saved, // saved.aiModel goes back as it is
    });
    // A prompt the server holds without a model keeps it that way ("" leaves the stored value) and offers what is picked.
    expect(updateBody({ listing: { ...listing, modelIds: ["m-gpt"] }, saved: { ...saved, aiModel: null }, id: "pid", catalogue }))
      .toMatchObject({ aiModel: "", aiModels: ["GPT Image"] });
  });
});
