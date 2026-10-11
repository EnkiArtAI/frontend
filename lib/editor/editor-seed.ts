import type { TextStore } from "./draft-store";
import { varNames } from "./prompt-tokens";
import type { EditorDoc } from "./undo";

export type EditorSeed = { kind: "library"; title: string; promptText: string };

/** The new editor imports text, not the old node graph (plan I2). */
export function librarySeed(item: { name: string; prompt_text: string | null }): EditorSeed | null {
  const text = item.prompt_text;
  if (!text?.trim() || /\{\{wf:[^}]*\}\}/i.test(text)) return null;
  return { kind: "library", title: item.name, promptText: text };
}

const key = (owner: string) => "enki-editor-seed:v1:" + owner;

export function stashSeed(storage: TextStore | null, owner: string | null, seed: EditorSeed): boolean {
  if (!storage || !owner) return false;
  try {
    storage.setItem(key(owner), JSON.stringify(seed));
    return true;
  } catch { return false; }
}

/** Read once, after this account's draft has been restored. */
export function takeSeed(storage: TextStore | null, owner: string | null): EditorSeed | null {
  if (!storage || !owner) return null;
  try {
    const raw = storage.getItem(key(owner));
    storage.removeItem(key(owner));
    const seed: unknown = JSON.parse(raw ?? "null");
    if (!seed || typeof seed !== "object") return null;
    const s = seed as Partial<EditorSeed>;
    return s.kind === "library" && typeof s.title === "string" && typeof s.promptText === "string"
      ? librarySeed({ name: s.title, prompt_text: s.promptText }) : null;
  } catch { return null; }
}

export function seedDoc(seed: EditorSeed): EditorDoc {
  const names = varNames(seed.promptText);
  return {
    prompt: seed.promptText,
    vars: Object.fromEntries(names.map((n) => [n, ""])),
    kinds: Object.fromEntries(names.map((n) => [n, "text" as const])),
    aiNames: [],
    refIds: [],
  };
}
