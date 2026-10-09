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
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { readReference } from "@/hooks/useReferenceReads";
import { browserBackend, draftKey, draftStore, type Draft } from "@/lib/editor/draft-store";
import type { RenderPicks } from "@/lib/editor/generate-checks";
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
  | { type: "restore"; key: string; draft: Draft | null; refs: RefStore }
  | { type: "seed"; loaded: LoadedPrompt; discard?: boolean };

const EMPTY: EditorDoc = { prompt: "", vars: {}, kinds: {}, aiNames: [], refIds: [] };

/** A new prompt: nothing picked (no generator is ever preselected), Premium at the default price. */
export const initialEditor = (): EditorState => ({
  history: startHistory(EMPTY),
  listing: { title: "", mode: "premium", price: DEFAULT_PROMPT_PRICE_USD, category: null, primaryId: null, testId: null },
  picks: { ratio: "4:5", resolution: "2K", quality: "medium", boost: false },
  stars: {},
  order: [],
  refs: {},
  released: false,
  key: null,
  restored: false,
  seeded: null,
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
    case "restore": {
      const next = { ...s, key: a.key, refs: { ...s.refs, ...a.refs } };
      const d = a.draft;
      if (!d) return next;
      return {
        ...next,
        history: startHistory(d.doc),
        listing: { ...s.listing, ...d.listing },
        picks: { ...s.picks, ...d.picks },
        stars: d.stars ?? {},
        order: d.order ?? [],
        restored: true,
      };
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
 * The "+ Variable" pill (handoff §4): the selected words become the unnamed
 * variable, their text its value, and the name is still to be typed.
 */
export const variableFrom = (range: VariableRange): DocPatch => (d) => ({
  prompt: d.prompt.slice(0, range.start) + "[]" + d.prompt.slice(range.end),
  vars: { ...d.vars, "": range.name },
  kinds: { ...d.kinds, "": "text" },
});

/** "+ Add variable": an empty unnamed variable at the end. There is only ever one unnamed. */
export const blankVariable: DocPatch = (d) =>
  varNames(d.prompt).includes("")
    ? {}
    : { prompt: insertToken(d.prompt, d.prompt.length, "[]").text, vars: { ...d.vars, "": "" }, kinds: { ...d.kinds, "": "text" } };

export function usePromptEditor(userKey: string | null, promptId: string | null) {
  const [state, dispatch] = useReducer(editorReducer, undefined, initialEditor);
  const store = useMemo(() => draftStore(browserBackend(), userKey, promptId), [userKey, promptId]);
  const key = userKey ? draftKey(userKey, promptId) : null;

  useEffect(() => {
    if (!key) return;
    let live = true;
    void store.loadRefs().then((refs) => {
      if (live) dispatch({ type: "restore", key, draft: store.load(), refs });
    });
    return () => {
      live = false;
    };
  }, [store, key]);

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

  return { state, doc: history.present, dispatch, commit: edit, store };
}
