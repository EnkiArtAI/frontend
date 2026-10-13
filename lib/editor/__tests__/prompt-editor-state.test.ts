import { describe, it, expect } from "vitest";
import { blankVariable, editorReducer, initialEditor, variableFrom, type DocPatch, type EditorState } from "@/components/prompt-editor/usePromptEditor";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { Draft } from "@/lib/editor/draft-store";
import type { LoadedPrompt } from "@/lib/editor/load-prompt";
import { releaseBody, storedRefs } from "@/lib/editor/release";
import { variableRange } from "@/lib/editor/selection-variable";
import type { EditorDoc } from "@/lib/editor/undo";

/**
 * The Prompt Editor's own state (components/prompt-editor/usePromptEditor):
 * what "✓ Released" survives, how a restored draft and a loaded prompt meet,
 * and the edits the "+ Variable" pill and "+ Add variable" make.
 */
const doc = (prompt: string, rest: Partial<EditorDoc> = {}): EditorDoc => ({ prompt, vars: {}, kinds: {}, aiNames: [], refIds: [], ...rest });
const apply = (d: EditorDoc, patch: DocPatch) => ({ ...d, ...(typeof patch === "function" ? patch(d) : patch) });
const withDoc = (d: EditorDoc): EditorState => editorReducer(initialEditor(), { type: "restore", key: "k", draft: { doc: d, listing: initialEditor().listing, picks: initialEditor().picks, stars: {}, order: [] }, refs: {} });
const released = (s: EditorState) => editorReducer(s, { type: "released", stored: {} });

const loaded: LoadedPrompt = {
  id: "p1",
  doc: doc("a [subject] by Reference image 1", { vars: { subject: "fox" }, refIds: ["https://x/1.webp"] }),
  refs: { "https://x/1.webp": { data: null, stored: "https://x/1.webp", state: "loading" } },
  listing: { title: "Fox", mode: "free", price: 0.07, category: "Portrait", modelIds: ["m1"], primaryId: "m1", testId: null },
  picks: { ratio: "16:9" },
  saved: { content: "", variables: [], referenceImages: [], uploadedPhotos: [], aspectRatio: "16:9", resolution: null },
};
const draft = (prompt: string): Draft => ({ doc: doc(prompt), listing: { ...initialEditor().listing, title: "Mine" }, picks: initialEditor().picks, stars: { j1: 5 }, order: ["x"] });

describe("a new prompt", () => {
  it("starts with nothing picked: no generator is ever preselected", () => {
    const s = initialEditor();
    expect(s.listing.primaryId).toBeNull();
    expect(s.listing.testId).toBeNull();
    expect(s.history.present.prompt).toBe("");
  });
});

describe("✓ Released", () => {
  it("goes with any edit, setting, star, undo or Generate, and stays while a reference is read in", () => {
    const s = released(withDoc(doc("a")));
    expect(s.released).toBe(true);
    expect(editorReducer(s, { type: "commit", patch: { prompt: "b" }, at: 1 }).released).toBe(false);
    expect(editorReducer(s, { type: "set", patch: { stars: {} } }).released).toBe(false);
    expect(editorReducer(s, { type: "generated", variation: "a" }).released).toBe(false);
    expect(editorReducer(s, { type: "undo" }).released).toBe(false);
    expect(editorReducer(s, { type: "redo" }).released).toBe(false);
    expect(editorReducer(s, { type: "ref", id: "r", ref: { data: "data:x", stored: null, state: "ready" } }).released).toBe(true);
  });

  it("takes the server's stored copies of the references sent, so the next release sends their URLs, never the data (Kev)", () => {
    const up = { data: "data:image/webp;base64,UP", stored: null, state: "ready" as const };
    const other = { data: "data:image/webp;base64,OTHER", stored: null, state: "ready" as const };
    const s = editorReducer(editorReducer(initialEditor(), { type: "ref", id: "up", ref: up }), { type: "ref", id: "other", ref: other });
    const cover = {
      id: "j1", createdAt: 1, status: "ready" as const, imageUrl: "https://x/j1.webp", seen: true,
      setup: { prompt: "a fox by [Reference image 1]", vars: {}, kinds: {}, refIds: ["up"], modelId: "m", modelName: "M", ratio: "1:1", resolution: "2K" as const, boost: false },
    };
    const primary: CatalogueEntry = { id: "m", name: "M", price: 0.1, mediaType: "image", supportsQuality: false, maxResolution: "2K", ratios: ["1:1"], free: false };
    const send = (st: EditorState) => {
      const r = releaseBody({ listing: { ...st.listing, title: "Fox", category: "Animals", mode: "free" }, primary, starred: [cover], refs: st.refs, catalogue: [primary] });
      if (!("body" in r)) throw new Error(r.error);
      return r;
    };
    const first = send(s);
    expect(first.body.referenceImages).toEqual([up.data]);
    const after = editorReducer(s, { type: "released", stored: storedRefs(first.refIds, ["https://blob/up.webp"]) });
    expect(after.released).toBe(true);
    expect(after.refs.up).toEqual({ ...up, stored: "https://blob/up.webp" });
    expect(after.refs.other).toBe(other);
    expect(send(after).body.referenceImages).toEqual(["https://blob/up.webp"]);
    // A stored URL for a reference no longer here adds nothing.
    expect(editorReducer(s, { type: "released", stored: { gone: "https://blob/gone.webp" } }).refs).toEqual(s.refs);
  });

  it("Generate keeps the variation's place in the order, once", () => {
    const once = editorReducer(initialEditor(), { type: "generated", variation: "v" });
    expect(editorReducer(once, { type: "generated", variation: "v" }).order).toEqual(["v"]);
  });
});

describe("the draft in this browser", () => {
  it("restoring one replaces the doc, the listing and the stars; restoring none keeps what is there", () => {
    const typed = editorReducer(initialEditor(), { type: "commit", patch: { prompt: "typed" }, at: 1 });
    const none = editorReducer(typed, { type: "restore", key: "k", draft: null, refs: { r: { data: "d", stored: null, state: "ready" } } });
    expect(none.history.present.prompt).toBe("typed");
    expect(none.key).toBe("k");
    expect(none.refs.r?.state).toBe("ready");
    expect(none.restored).toBe(false);
    const some = editorReducer(typed, { type: "restore", key: "k", draft: draft("saved"), refs: {} });
    expect(some.history.present.prompt).toBe("saved");
    expect(some.history.past).toEqual([]);
    expect(some.listing.title).toBe("Mine");
    expect(some.stars).toEqual({ j1: 5 });
    expect(some.order).toEqual(["x"]);
    expect(some.restored).toBe(true);
  });

  it("a loaded prompt is seeded in, unless a draft of it was restored; Discard puts the server's back", () => {
    const seeded = editorReducer(initialEditor(), { type: "seed", loaded });
    expect(seeded.history.present).toEqual(loaded.doc);
    expect(seeded.listing).toEqual(loaded.listing);
    expect(seeded.picks.ratio).toBe("16:9");
    expect(seeded.seeded).toBe("p1");
    expect(seeded.refs["https://x/1.webp"]?.state).toBe("loading");

    const mine = editorReducer(editorReducer(initialEditor(), { type: "restore", key: "k", draft: draft("my edit"), refs: {} }), { type: "seed", loaded });
    expect(mine.history.present.prompt).toBe("my edit");
    expect(mine.seeded).toBe("p1");
    expect(mine.restored).toBe(true);

    const back = editorReducer(mine, { type: "seed", loaded, discard: true });
    expect(back.history.present).toEqual(loaded.doc);
    expect(back.stars).toEqual({});
    expect(back.restored).toBe(false);
  });

  it("an image this browser already read in beats the stored URL still to be read", () => {
    const read = { data: "data:image/webp;base64,x", stored: "https://x/1.webp", state: "ready" as const };
    const s = editorReducer(editorReducer(initialEditor(), { type: "ref", id: "https://x/1.webp", ref: read }), { type: "seed", loaded });
    expect(s.refs["https://x/1.webp"]).toEqual(read);
  });
});

describe("making a variable", () => {
  it("the + Variable pill turns the checked selection into a variable under the suggested name, its text the value", () => {
    const text = "a red fox at dawn";
    const range = variableRange(text, 1, 6);
    expect(range).not.toBeNull();
    const next = apply(doc(text, { vars: { fox: "x" } }), variableFrom(range!, "red"));
    expect(next.prompt).toBe("a [red] fox at dawn");
    expect(next.vars).toEqual({ fox: "x", red: "red" });
    expect(next.kinds.red).toBe("text");
  });

  it("+ Add variable puts one empty unnamed variable at the end, spaced, and never a second", () => {
    const one = apply(doc("a fox", { vars: { "": "old" } }), blankVariable);
    expect(one.prompt).toBe("a fox []");
    expect(one.vars[""]).toBe("");
    expect(one.kinds[""]).toBe("text");
    expect(apply(one, blankVariable)).toEqual(one);
  });
});
