"use client";

import { renameVar, removeVar, varNames } from "@/lib/editor/prompt-tokens";
import type { EditorDoc } from "@/lib/editor/undo";
import { storedName } from "@/lib/generation/stored-name";
import type { DocPatch } from "./usePromptEditor";
import VariableRow from "./VariableRow";

/** Names the save could not store as they are (R19, app/api/prompt): flagged on their rows, and they block Release. */
function nameIssues(names: string[]): Map<string, string> {
  const issues = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const n of names) {
    if (!n) continue;
    const stored = storedName(n);
    if (stored === null) {
      issues.set(n, "Use letters a–z or digits");
      continue;
    }
    const other = seen.get(stored);
    if (other === undefined) seen.set(stored, n);
    else {
      issues.set(n, `Saved as the same name as [${other}] — rename one`);
      issues.set(other, `Saved as the same name as [${n}] — rename one`);
    }
  }
  return issues;
}

/**
 * The variables of the prompt, in the order they first appear, the unnamed
 * one included. Rows are keyed by position, and so are their undo steps
 * (a rename folds under rename:<index>, typing under var:<index>).
 */
export default function VariableList({ doc, commit, isHeld, release, onAdd, suggested, onNamed }: {
  doc: EditorDoc;
  commit: (patch: DocPatch, key?: string) => void;
  /** Grow-only fields (useGrowOnly), keyed var:<name>. */
  isHeld: (key: string) => boolean;
  release: (key: string) => void;
  onAdd: () => void;
  /** Names the "+ Variable" pill made up: red until their row is edited or left. */
  suggested: ReadonlySet<string>;
  onNamed: (name: string) => void;
}) {
  const names = varNames(doc.prompt);
  const issues = nameIssues(names);

  const rename = (i: number, from: string, to: string): string | null => {
    const r = renameVar(doc.prompt, from, to);
    if (!r.ok) {
      if (r.reason === "reserved") return "That name is reserved for images";
      if (r.reason === "invalid") return "Names can't hold brackets";
      return r.other === to || !r.other
        ? `Another variable is already called “${to}”`
        : `“${r.other}” is saved under the same name · saved names ignore case and symbols`;
    }
    commit({
      prompt: r.text,
      vars: { ...doc.vars, [to]: doc.vars[from] ?? "" },
      kinds: { ...doc.kinds, [to]: doc.kinds[from] ?? "text" },
      aiNames: doc.aiNames.map((n) => (n === from ? to : n)),
    }, `rename:${i}`);
    return null;
  };

  return (
    <section className="pe-vars" aria-label="Variables">
      <div className="pe-vars-head">
        <span className="kit-label">Variables · {names.length}</span>
        <span className="pe-vars-tools">
          <span className="pe-hint">People fill these in</span>
          <button type="button" className="pe-add pe-wide-only kit-hit" onClick={onAdd}>+ Add variable</button>
        </span>
      </div>
      {!names.length && (
        <p className="pe-empty">No variables yet. Select a word in the prompt and click + Variable, or type [brackets].</p>
      )}
      {names.map((name, i) => (
        <VariableRow key={i} name={name} value={doc.vars[name] ?? ""} kind={doc.kinds[name] ?? "text"}
          ai={doc.aiNames.includes(name)} issue={issues.get(name) ?? null} suggested={suggested.has(name)}
          growOnly={isHeld(`var:${name}`)} onUserInput={() => release(`var:${name}`)}
          onRename={(to) => rename(i, name, to)} onNamed={() => onNamed(name)}
          onValue={(v) => commit((d) => ({ vars: { ...d.vars, [name]: v }, aiNames: d.aiNames.filter((n) => n !== name) }), `var:${i}`)}
          onKind={(k) => commit((d) => ({ kinds: { ...d.kinds, [name]: k } }))}
          onRemove={() => {
            onNamed(name);
            commit((d) => ({ prompt: removeVar(d.prompt, name, d.vars[name] ?? "") }));
          }} />
      ))}
    </section>
  );
}
