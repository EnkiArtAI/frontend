import { stashSeed, takeSeed, type EditorSeed } from "@/lib/editor/editor-seed";

const storage = () => {
  try { return window.sessionStorage; } catch { return null; }
};

export const stashEditorSeed = (seed: EditorSeed, owner: string | null) => stashSeed(storage(), owner, seed);
export const takeEditorSeed = (owner: string | null) => takeSeed(storage(), owner);

// The unmounted legacy buyer still imports these; C3 removes that caller.
export const EDIT_PROMPT_EVENT = "enki:edit-prompt";

let pending: unknown = null;

export function requestPromptEdit(prompt: unknown) {
  pending = prompt;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EDIT_PROMPT_EVENT));
}

export function consumePromptEdit(): unknown {
  const p = pending;
  pending = null;
  return p;
}
