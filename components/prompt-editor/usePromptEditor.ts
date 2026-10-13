"use client";

/**
 * The Prompt Editor's own state (plan §2.1): the doc with its undo history,
 * the listing, the settings row, the stars, the variation order and the
 * reference images. Server data (catalogue, quotes, balance, the loaded
 * prompt) never lives here.
 *
 * The draft stays in this browser, per account and per prompt
 * (lib/editor/draft-store, R15): restored once for each key, then saved 400 ms
 * after the last change. A loaded prompt (E2) is seeded in unless a draft of
 * it was restored; the draft wins, and the editor offers to discard it.
 */
import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef } from "react";
import { readReference } from "@/hooks/useReferenceReads";
import { browserBackend, draftKey, draftStore, type Draft } from "@/lib/editor/draft-store";
import type { RenderPicks } from "@/lib/editor/generate-checks";
import { stashEditorSeed, takeEditorSeed } from "@/components/enki-shell/editorBridge";
import { seedDoc, type EditorSeed } from "@/lib/editor/editor-seed";
import type { LoadedPrompt } from "@/lib/editor/load-prompt";
import { insertToken, varNames } from "@/lib/editor/prompt-tokens";
import type { Listing } from "@/lib/editor/release";
import type { VariableRange } from "@/lib/editor/selection-variable";
import { commit, redo, startHistory, undo, type EditorDoc, type History, type RefImage, type RefStore } from "@/lib/editor/undo";
import { withVariation, type Stars } from "@/lib/editor/variations";
import { DEFAULT_PROMPT_PRICE_USD } from "@/shared/revenue-config";

export interface EditorState {
  history: History;
  listing: Listing;
  picks: RenderPicks;
  stars: Stars;
  order: string[];
  refs: RefStore;
  /** The last release went through and nothing changed since: "✓ Released". */
  released: boolean;
  /** The draft key restored from. Saving waits for it, so the empty start never overwrites a draft. */
  key: string | null;
  /** A draft from this browser stands in for the prompt as the server holds it. */
  restored: boolean;
  /** The id of the server prompt seeded in. */
  seeded: string | null;
  pendingSeed: EditorSeed | null;
}

export type DocPatch = Partial<EditorDoc> | ((doc: EditorDoc) => Partial<EditorDoc>);

export type EditorAction =
  | { type: "commit"; patch: DocPatch; at: number; key?: string }
  | { type: "undo" | "redo" }
  /** `stored`: the server's copies of the references sent, by ref id (lib/editor/release storedRefs). */
  | { type: "released"; stored: Record<string, string> }
  | { type: "set"; patch: Partial<Pick<EditorState, "listing" | "picks" | "stars">> }
  | { type: "generated"; variation: string }
  | { type: "ref"; id: string; ref: RefImage }
  | { type: "restore"; key: string; draft: Draft | null; refs: RefStore; seed?: EditorSeed | null }
  | { type: "library"; seed: EditorSeed }
  | { type: "dismiss-library" }
  | { type: "seed"; loaded: LoadedPrompt; discard?: boolean };

const EMPTY: EditorDoc = { prompt: "", vars: {}, kinds: {}, aiNames: [], refIds: [] };

/** A draft saved before the generator multi-select has no modelIds: its primary is the one on offer. */
const withModels = (l: Listing): Listing => (Array.isArray(l.modelIds) ? l : { ...l, modelIds: l.primaryId ? [l.primaryId] : [] });

/** A new prompt: nothing picked (no generator is ever preselected), Premium at the default price. */
export const initialEditor = (): EditorState => ({
  history: startHistory(EMPTY),
  listing: { title: "", mode: "premium", price: DEFAULT_PROMPT_PRICE_USD, category: null, modelIds: [], primaryId: null, testId: null },
  picks: { ratio: "4:5", resolution: "2K", quality: "medium", boost: false },
  stars: {},
  order: [],
  refs: {},
  released: false,
  key: null,
  restored: false,
  seeded: null,
  pendingSeed: null,
});

/** Any edit, star, setting or Generate takes "✓ Released" away; only reading a reference in does not. */
export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  switch (a.type) {
    case "commit": {
      const patch = typeof a.patch === "function" ? a.patch(s.history.present) : a.patch;
      return { ...s, history: commit(s.history, patch, a.at, a.key), released: false };
    }
    case "undo":
      return { ...s, history: undo(s.history), released: false };
    case "redo":
      return { ...s, history: redo(s.history), released: false };
    case "released": {
      // A stored copy goes out instead of the data from now on: never stored, or judged, twice.
      const refs = { ...s.refs };
      for (const [id, stored] of Object.entries(a.stored)) if (refs[id]) refs[id] = { ...refs[id], stored };
      return { ...s, refs, released: true };
    }
    case "set":
      return { ...s, ...a.patch, released: false };
    case "generated":
      return { ...s, order: withVariation(s.order, a.variation), released: false };
    case "ref":
      return { ...s, refs: { ...s.refs, [a.id]: a.ref } };
    case "library":
      return {
        ...initialEditor(),
        key: s.key,
        history: startHistory(seedDoc(a.seed)),
        listing: { ...initialEditor().listing, title: a.seed.title },
      };
    case "dismiss-library":
      return { ...s, pendingSeed: null };
    case "restore": {
      const next = { ...s, key: a.key, refs: { ...s.refs, ...a.refs } };
      const d = a.draft;
      const restored = !d ? next : {
        ...next,
        history: startHistory(d.doc),
        listing: withModels({ ...s.listing, ...d.listing }),
        picks: { ...s.picks, ...d.picks },
        stars: d.stars ?? {},
        order: d.order ?? [],
        restored: true,
      };
      if (!a.seed) return restored;
      const doc = restored.history.present;
      const occupied = !!doc.prompt.trim() || !!restored.listing.title.trim()
        || Object.values(doc.vars).some((v) => v.trim()) || !!doc.refIds.length
        || !!restored.order.length || !!Object.keys(restored.stars).length;
      return occupied ? { ...restored, pendingSeed: a.seed } : editorReducer(restored, { type: "library", seed: a.seed });
    }
    case "seed": {
      const l = a.loaded;
      // A reference this browser already read in beats the stored URL still to be read.
      const next = { ...s, seeded: l.id, refs: { ...l.refs, ...s.refs } };
      if (s.restored && !a.discard) return next;
      return {
        ...next,
        history: startHistory(l.doc),
        listing: l.listing,
        picks: { ...s.picks, ...l.picks },
        stars: a.discard ? {} : s.stars,
        restored: false,
        released: false,
      };
    }
  }
}

/**
 * The "+ Variable" pill (handoff §4): the selected words become a variable
 * under `name` (lib/editor/selection-variable suggestedName), their text its
 * example value. The row shows the name red until it is changed.
 */
export const variableFrom = (range: VariableRange, name: string): DocPatch => (d) => ({
  prompt: d.prompt.slice(0, range.start) + `[${name}]` + d.prompt.slice(range.end),
  vars: { ...d.vars, [name]: range.name },
  kinds: { ...d.kinds, [name]: "text" },
});

/** "+ Add variable": an empty unnamed variable at the end. There is only ever one unnamed. */
export const blankVariable: DocPatch = (d) =>
  varNames(d.prompt).includes("")
    ? {}
    : { prompt: insertToken(d.prompt, d.prompt.length, "[]").text, vars: { ...d.vars, "": "" }, kinds: { ...d.kinds, "": "text" } };

export function usePromptEditor(userKey: string | null, promptId: string | null, seedOwner: string | null = null) {
  const [state, dispatch] = useReducer(editorReducer, undefined, initialEditor);
  const draftOwner = userKey ?? (seedOwner ? "account:" + seedOwner : null);
  const store = useMemo(() => draftStore(browserBackend(), draftOwner, promptId), [draftOwner, promptId]);
  const key = draftOwner ? draftKey(draftOwner, promptId) : null;

  const draftOf = (s: EditorState): Draft => ({ doc: s.history.present, listing: s.listing, picks: s.picks, stars: s.stars, order: s.order });
  const restore = useEffectEvent((action: Extract<EditorAction, { type: "restore" }>) => {
    const next = editorReducer(state, action);
    if (action.seed) {
      if (next.pendingSeed) stashEditorSeed(action.seed, seedOwner);
      else { store.save(draftOf(next)); store.saveRefs(next.refs); }
    }
    dispatch(action);
  });
  const decideSeed = (replace: boolean) => {
    if (!state.pendingSeed) return;
    takeEditorSeed(seedOwner);
    if (replace) {
      const next = editorReducer(state, { type: "library", seed: state.pendingSeed });
      store.save(draftOf(next));
      store.saveRefs(next.refs);
      dispatch({ type: "library", seed: state.pendingSeed });
    } else dispatch({ type: "dismiss-library" });
  };

  useEffect(() => {
    if (!key) return;
    let live = true;
    void store.loadRefs().then((refs) => {
      if (live) restore({ type: "restore", key, draft: store.load(), refs, seed: promptId === null ? takeEditorSeed(seedOwner) : null });
    });
    return () => {
      live = false;
    };
  }, [store, key, promptId, seedOwner]);

  const { history, listing, picks, stars, order, refs } = state;
  const ready = key !== null && state.key === key;
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!ready) return;
    const save = () => {
      pending.current = null;
      store.save({ doc: history.present, listing, picks, stars, order });
    };
    pending.current = save;
    const t = setTimeout(save, 400);
    return () => clearTimeout(t);
  }, [ready, store, history.present, listing, picks, stars, order]);
  // Leaving inside the 400 ms keeps the last keystrokes too (this cleanup runs before the next one).
  useEffect(() => () => pending.current?.(), []);
  // A new key (the first release moves the draft to its id) never gets the old key's write.
  useEffect(() => () => {
    pending.current = null;
  }, [store]);
  // The images only when they change: they are large.
  useEffect(() => {
    if (ready) store.saveRefs(refs);
  }, [ready, store, refs]);

  // A stored image (a loaded prompt, or a reload) is read into data before a render can send it.
  const reading = useRef(new Set<string>());
  useEffect(() => {
    for (const [id, r] of Object.entries(refs)) {
      if (r.state !== "loading" || !r.stored || reading.current.has(id)) continue;
      reading.current.add(id);
      void fetch(r.stored)
        .then((res) => (res.ok ? res.blob() : null))
        .catch(() => null)
        .then((blob) => (blob ? readReference(blob) : null))
        .then((data) => dispatch({ type: "ref", id, ref: { ...r, data, state: data ? "ready" : "failed" } }))
        .finally(() => reading.current.delete(id));
    }
  }, [refs]);

  const edit = useCallback((patch: DocPatch, key?: string) => dispatch({ type: "commit", patch, at: Date.now(), key }), []);

  return { state, doc: history.present, dispatch, commit: edit, store, decideSeed };
}
