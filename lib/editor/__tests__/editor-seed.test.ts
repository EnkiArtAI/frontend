import { describe, it, expect } from "vitest";
import { librarySeed, seedDoc, stashSeed, takeSeed, type EditorSeed } from "../editor-seed";
import type { TextStore } from "../draft-store";
import { editorReducer, initialEditor } from "@/components/prompt-editor/usePromptEditor";
import { readSource } from "@/lib/__tests__/_read-source";
import { join } from "node:path";

const seed: EditorSeed = { kind: "library", title: "Harbour", promptText: "  A [subject] at dawn.\n" };
const memory = (): TextStore => {
  const items = new Map<string, string>();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => { items.set(k, v); }, removeItem: (k) => { items.delete(k); } };
};

describe("the library text seed", () => {
  it("keeps the saved title and text exactly, including whitespace", () => {
    expect(librarySeed({ name: seed.title, prompt_text: seed.promptText })).toEqual(seed);
    const doc = seedDoc(seed);
    expect(doc).toEqual({ prompt: seed.promptText, vars: { subject: "" }, kinds: { subject: "text" }, aiNames: [], refIds: [] });
  });
  it.each([null, "", " \n", "A {{wf:node-7}} portrait", "{{WF:n}}"])("refuses a missing text or unsupported workflow: %j", (text) => {
    expect(librarySeed({ name: "Old workflow", prompt_text: text })).toBeNull();
  });
  it("survives navigation and a reload, and is consumed only once", () => {
    const storage = memory();
    expect(stashSeed(storage, "alice", seed)).toBe(true);
    expect(takeSeed(storage, "alice")).toEqual(seed);
    expect(takeSeed(storage, "alice")).toBeNull();
  });
  it("never gives one account another account's private prompt", () => {
    const storage = memory();
    stashSeed(storage, "alice", seed);
    expect(takeSeed(storage, "bob")).toBeNull();
    expect(takeSeed(storage, "alice")).toEqual(seed);
  });
  it("works without exposing the draft when signed out or storage is unavailable", () => {
    expect(stashSeed(memory(), null, seed)).toBe(false);
    expect(stashSeed(null, "alice", seed)).toBe(false);
    expect(takeSeed(null, "alice")).toBeNull();
    expect(takeSeed(memory(), null)).toBeNull();
  });
  it("reports a storage failure instead of navigating to an empty editor", () => {
    const broken = { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("full"); }, removeItem: () => {} };
    expect(stashSeed(broken, "alice", seed)).toBe(false);
    expect(takeSeed(broken, "alice")).toBeNull();
  });
  it.each(["{", "null", '{"kind":"library","title":3,"promptText":"text"}', '{"kind":"other","title":"x","promptText":"text"}', '{"kind":"library","title":"x","promptText":"{{wf:n}}"}'])("discards an invalid stored value: %s", (raw) => {
    const storage = memory();
    storage.setItem("enki-editor-seed:v1:alice", raw);
    expect(takeSeed(storage, "alice")).toBeNull();
    expect(storage.getItem("enki-editor-seed:v1:alice")).toBeNull();
  });
});

describe("import after the existing draft is restored", () => {
  it("imports into an empty draft without preselecting a generator or reusing preview stars", () => {
    const state = editorReducer(initialEditor(), { type: "restore", key: "alice:new", draft: null, refs: {}, seed });
    expect(state.history.present).toEqual(seedDoc(seed));
    expect(state.listing.title).toBe(seed.title);
    expect(state.listing.primaryId).toBeNull();
    expect(state.listing.testId).toBeNull();
    expect(state.pendingSeed).toBeNull();
    expect(state.stars).toEqual({});
    expect(state.key).toBe("alice:new");
    expect(state.released).toBe(false);
  });
  it("keeps a non-empty restored draft until the user confirms replacement", () => {
    const start = initialEditor();
    const draft = { doc: { ...start.history.present, prompt: "My unsaved work" }, listing: { ...start.listing, title: "Mine" }, picks: start.picks, stars: { j1: 4 }, order: ["v1"] };
    const pending = editorReducer(start, { type: "restore", key: "alice:new", draft, refs: {}, seed });
    expect(pending.history.present.prompt).toBe("My unsaved work");
    expect(pending.listing.title).toBe("Mine");
    expect(pending.stars).toEqual({ j1: 4 });
    expect(pending.pendingSeed).toEqual(seed);
    const imported = editorReducer(pending, { type: "library", seed: pending.pendingSeed! });
    expect(imported.history.present).toEqual(seedDoc(seed));
    expect(imported.stars).toEqual({});
    expect(imported.order).toEqual([]);
    expect(imported.restored).toBe(false);
    expect(imported.key).toBe("alice:new");
    const kept = editorReducer(pending, { type: "dismiss-library" });
    expect(kept.history).toBe(pending.history);
    expect(kept.listing).toBe(pending.listing);
    expect(kept.pendingSeed).toBeNull();
  });
  it("also protects a title-only draft", () => {
    const start = initialEditor();
    const draft = { doc: start.history.present, listing: { ...start.listing, title: "Title I wrote" }, picks: start.picks, stars: {}, order: [] };
    const pending = editorReducer(start, { type: "restore", key: "k", draft, refs: {}, seed });
    expect(pending.listing.title).toBe("Title I wrote");
    expect(pending.pendingSeed).toEqual(seed);
  });
});

describe("the real entry points", () => {
  const root = join(__dirname, "../../..");
  const profile = readSource(join(root, "components/profile/ProfileView.tsx"));
  const hook = readSource(join(root, "components/prompt-editor/usePromptEditor.ts"));
  const editor = readSource(join(root, "components/prompt-editor/PromptEditor.tsx"));
  it("uses a persisted text seed then /editor, including the standalone profile", () => {
    expect(profile).toContain('const seed = librarySeed(it)');
    expect(profile).toContain('if (stashEditorSeed(seed, seedOwner)) router.push("/editor")');
    expect(profile).not.toContain("requestPromptEdit");
    expect(readSource(join(root, "components/enki-shell/EnkiHome.tsx"))).not.toContain("EDIT_PROMPT_EVENT");
  });
  it("consumes the seed after draft restoration and only for a new prompt", () => {
    expect(hook).toContain('draft: store.load(), refs, seed: promptId === null ? takeEditorSeed(seedOwner) : null');
    expect(editor).toContain('usePromptEditor(userKey, id, signedIn ? userId : null)');
    expect(editor).toContain('open={!!state.pendingSeed}');
    const gate = readSource(join(root, "components/BetaGate.tsx"));
    expect(gate).toContain("userId: meId");
    expect(profile).toContain("userId: seedOwner");
    expect(editor).toContain('Replace your unsaved draft?');
    expect(editor).toContain("decideSeed(false)");
    expect(editor).toContain("decideSeed(true)");
  });
});
