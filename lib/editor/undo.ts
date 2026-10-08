/**
 * Undo and redo in the Prompt Editor (handoff §4.3): the prompt, the values,
 * the kinds, the ✦ AI marks and the references. Listing, settings, stars and
 * jobs are not in it. A step is the whole doc, so redo gives back exactly
 * what undo took, the AI marks included (plan R20; the prototype dropped
 * them). Time is passed in: nothing here reads the clock.
 */

export type VarKind = "text" | "checkbox";

export interface EditorDoc {
  /** The editor text: [name] a variable, [] the unnamed one, [Reference image n] the n-th reference. */
  prompt: string;
  /** Values by name, kept after a token goes, so retyping [name] brings its value back. A checkbox's value is the text it adds. */
  vars: Record<string, string>;
  kinds: Record<string, VarKind>;
  /** Names whose value Vary wrote (the ✦ AI badge). */
  aiNames: string[];
  /** The references in "Reference image n" order, as keys of the RefStore. */
  refIds: string[];
}

/** A reference image. The doc holds only its id, so reading it in is never an undo step. */
export interface RefImage {
  /** What a render sends: a data: URL. Null until a stored image has been read. */
  data: string | null;
  /** The https URL a loaded prompt came with; a release sends it back unchanged. */
  stored: string | null;
  state: "ready" | "loading" | "failed";
}

export type RefStore = Record<string, RefImage>;

export interface History {
  past: EditorDoc[];
  present: EditorDoc;
  future: EditorDoc[];
  /** The key and time of the last commit, for folding keystrokes into one step. */
  key: string | null;
  at: number;
}

/** Commits under one key at most this far apart are one step. */
export const COALESCE_MS = 900;
export const MAX_STEPS = 60;

export const startHistory = (doc: EditorDoc): History => ({ past: [], present: doc, future: [], key: null, at: 0 });

/**
 * `patch` as a new step, or folded into the last one when it has the same
 * key and came at most COALESCE_MS after it. A commit without a key is always
 * its own step, and every commit drops the redo steps.
 */
export function commit(h: History, patch: Partial<EditorDoc>, now: number, key?: string): History {
  const fold = key === h.key && now - h.at <= COALESCE_MS;
  return {
    past: fold ? h.past : [...h.past, h.present].slice(-MAX_STEPS),
    present: { ...h.present, ...patch },
    future: [],
    key: key ?? null,
    at: now,
  };
}

/** The step before; the next commit never folds into what came back. */
export function undo(h: History): History {
  const prev = h.past.at(-1);
  return prev ? { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future], key: null, at: h.at } : h;
}

export function redo(h: History): History {
  const [next, ...future] = h.future;
  return next ? { past: [...h.past, h.present], present: next, future, key: null, at: h.at } : h;
}
