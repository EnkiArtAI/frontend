import { describe, it, expect } from "vitest";
import { loadPrompt, slotVariable, type ServerPrompt, type ServerVariable } from "../load-prompt";
import { toServerText } from "../prompt-tokens";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import { DEFAULT_PROMPT_PRICE_USD } from "@/shared/revenue-config";

const v = (name: string, label: string, o: Partial<ServerVariable> = {}): ServerVariable => ({
  name, label, description: "", type: "text", defaultValue: "", required: true, position: 0, min: null, max: null, options: null, ...o,
});
const catalogue: CatalogueEntry[] = [
  { id: "m-flux", name: "Flux (free)", price: 0, mediaType: "image", supportsQuality: false, maxResolution: "2K", ratios: ["1:1"], free: true },
  { id: "m-pro", name: "Nano Banana Pro", price: 0.1, mediaType: "image", supportsQuality: false, maxResolution: "4K", ratios: ["1:1"], free: false },
];
const R1 = "https://blob/r1.webp";
const R2 = "https://blob/r2.webp";
const server: ServerPrompt = {
  id: "pid",
  title: "Night market",
  content: "A [Red car] in [neon], Reference image 1 and Reference image 3, [ 2nd shot ] [猫] [extra]",
  category: "Poster",
  aiModel: "Nano Banana Pro",
  price: 0.4,
  aspectRatio: "3:2",
  promptType: "paid-prompt",
  uploadedPhotos: ["https://blob/s1.webp"],
  referenceImages: [R1, R2],
  resolution: "4K",
  variables: [
    v("red_car", "Red car", { defaultValue: "a red car" }),
    v("neon", "pink glow", { type: "checkbox", description: "pink neon glow", defaultValue: true, required: false, position: 1 }),
    v("v_2nd_shot", " 2nd shot ", { defaultValue: "close-up", position: 2 }),
    v("var_3", "猫", { type: "slider", defaultValue: 3, min: 0, max: 5, position: 3 }),
    v("orphan", "orphan", { defaultValue: "kept", position: 4 }),
  ],
};

describe("slotVariable", () => {
  it("matches by name, then by the stored name, then by label", () => {
    const byName = v("Cat", "x");
    const byStored = v("cat", "y");
    const byLabel = v("zz", "Cat");
    expect(slotVariable("Cat", [byLabel, byStored, byName])).toBe(byName);
    expect(slotVariable("Cat", [byLabel, byStored])).toBe(byStored);
    expect(slotVariable("Cat", [byLabel])).toBe(byLabel);
    expect(slotVariable("Cat", [v("dog", "Dog")])).toBeUndefined();
    expect(slotVariable("猫", [v("var_0", "x"), v("var_1", "猫")])?.name).toBe("var_1");
  });
});

describe("loadPrompt", () => {
  const loaded = loadPrompt(server, catalogue);

  it("reads the text back with tokens only for the references that exist", () => {
    expect(loaded.doc.prompt).toBe("A [Red car] in [neon], [Reference image 1] and Reference image 3, [ 2nd shot ] [猫] [extra]");
    expect(toServerText(loaded.doc.prompt)).toBe(server.content);
  });

  it("fills each slot from its variable; a checkbox's text is its description, else its label", () => {
    expect(loaded.doc.vars).toEqual({ "Red car": "a red car", neon: "pink neon glow", " 2nd shot ": "close-up", 猫: "3", extra: "" });
    expect(loaded.doc.kinds).toEqual({ "Red car": "text", neon: "checkbox", " 2nd shot ": "text", 猫: "text", extra: "text" });
    expect(loaded.doc.aiNames).toEqual([]);
    const box = loadPrompt({ ...server, content: "[tick]", variables: [v("tick", "tick text", { type: "checkbox" })] }, catalogue);
    expect(box.doc.vars).toEqual({ tick: "tick text" });
    const blank = loadPrompt({ ...server, content: "[x]", variables: [v("x", "x", { defaultValue: null })] }, catalogue);
    expect(blank.doc.vars).toEqual({ x: "" });
  });

  it("keeps the references as stored URLs, to be read in before a render", () => {
    expect(loaded.doc.refIds).toEqual([R1, R2]);
    expect(loaded.refs).toEqual({ [R1]: { data: null, stored: R1, state: "loading" }, [R2]: { data: null, stored: R2, state: "loading" } });
  });

  it("maps the listing: a paid prompt is Premium at its price, a known category, the model by name or id", () => {
    expect(loaded.listing).toEqual({ title: "Night market", mode: "premium", price: 0.4, category: "Poster", primaryId: "m-pro", testId: null });
    expect(loadPrompt({ ...server, aiModel: "m-flux" }, catalogue).listing.primaryId).toBe("m-flux");
    expect(loadPrompt({ ...server, aiModel: "nano-banana-pro" }, catalogue).listing.primaryId).toBe("m-pro");
    expect(loadPrompt({ ...server, aiModel: "Midjourney" }, catalogue).listing.primaryId).toBeNull();
    expect(loadPrompt({ ...server, aiModel: null }, catalogue).listing.primaryId).toBeNull();
  });

  it("a free prompt is Free and would start Premium at the default price; an unknown category is none", () => {
    const free = loadPrompt({ ...server, promptType: "free-prompt", price: 0, category: "Cinematic" }, catalogue).listing;
    expect([free.mode, free.price, free.category]).toEqual(["free", DEFAULT_PROMPT_PRICE_USD, null]);
  });

  it("takes the saved ratio and resolution where they are real", () => {
    expect(loaded.picks).toEqual({ ratio: "3:2", resolution: "4K" });
    expect(loadPrompt({ ...server, aspectRatio: null, resolution: "8K" }, catalogue).picks).toEqual({});
  });

  it("keeps the prompt as stored for a listing-only update, each variable under its slot's own text", () => {
    expect(loaded.saved).toEqual({
      content: server.content,
      variables: [
        { ...server.variables[0], name: "Red car" },
        server.variables[1],
        { ...server.variables[2], name: " 2nd shot " },
        { ...server.variables[3], name: "猫" },
        server.variables[4],
      ],
      referenceImages: [R1, R2],
      uploadedPhotos: ["https://blob/s1.webp"],
      aspectRatio: "3:2",
      resolution: "4K",
    });
  });
});
