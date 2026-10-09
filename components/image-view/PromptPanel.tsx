"use client";

import type { ClipboardEvent, FocusEvent, KeyboardEvent } from "react";
import { Copy, Loader2, Lock } from "lucide-react";
import PillMenu from "@/components/kit/PillMenu";
import PromptMirror from "@/components/kit/PromptMirror";
import Segmented from "@/components/kit/Segmented";
import VariableField from "@/components/kit/VariableField";
import { parseTokens } from "@/lib/editor/prompt-tokens";
import { PROMPT_MAX } from "@/lib/ui/image-view/assemble";
import type { Segment } from "@/lib/ui/image-view/segments";
import { sendValue, type Field } from "@/lib/ui/image-view/variables";
import { fieldKind, type PromptVariable as KitVariable } from "@/lib/ui/kit/fields";
import { copyText, focusField, PROMPT_KEY, type ImageViewModel } from "./useImageViewModel";

/** The kit field for a composer input; a slot the buyer typed is asked as text. */
const asVariable = (f: Field): KitVariable =>
  f.variable
    ? { ...f.variable, defaultValue: null }
    : { id: f.key, name: f.key, label: f.label, description: "", type: "text", defaultValue: null, required: false, position: 0, min: null, max: null, options: null };

/**
 * The prompt and the buyer's values (handoff §2). A free prompt (and the
 * blank composer) shows its text: T edits it with the [slots] coloured, [ ]
 * writes the values into the sentence and edits them in place. A premium
 * prompt shows its price where the text would be, and only the fields.
 */
export default function PromptPanel({ model: m }: { model: ImageViewModel }) {
  if (m.text === null) return <Locked model={m} />;
  const filled = m.view === "filled" && !!m.segments?.some((s) => s.kind === "var");
  return (
    <section className="iv-prompt">
      <div className="iv-sec-head">
        <span className="iv-label">{m.blank ? "Prompt" : filled ? "Prompt · free · filled" : "Prompt · free"}</span>
        <span className="iv-sec-tools">
          {m.segments?.some((s) => s.kind === "var") && (
            <span className="iv-tv">
              <Segmented ariaLabel="Show the prompt" role="radiogroup" value={m.view} onChange={m.setView}
                options={[
                  { key: "filled", label: "[ ]", title: "Variables written out" },
                  { key: "text", label: <span className="iv-t">T</span>, title: "Prompt text" },
                ]} />
            </span>
          )}
          <button type="button" className="iv-copy kit-hit" aria-label="Copy prompt" title="Copy prompt" onClick={m.copyPrompt}>
            <Copy size={12} strokeWidth={2.2} aria-hidden />
          </button>
        </span>
      </div>
      {filled ? <Inline model={m} segments={m.segments ?? []} /> : <Text model={m} text={m.text} />}
      {!filled && <Fields model={m} />}
    </section>
  );
}

function Text({ model: m, text }: { model: ImageViewModel; text: string }) {
  const tokens = parseTokens(text, { refs: "plain" });
  return (
    <>
      <PromptMirror className="iv-pm" aria-label="Prompt" value={text} onChange={(v) => m.setText(v)} tokens={tokens}
        missingRefs={tokens.flatMap((t) => (t.kind === "ref" && t.n > m.refs.length ? [t.n] : []))}
        min={150} max={300} growOnly={m.growOnly(PROMPT_KEY)} onUserInput={() => m.release(PROMPT_KEY)}
        placeholder={m.blank ? "Describe the image you want…" : undefined}
        selectionPill={{ onCreate: m.addVariable }} />
      <p className="iv-hint">
        {m.blank ? "Your own prompt · [brackets] become fields below" : "Free prompt · edit anything, [brackets] are the variables"}
        {m.edited && !m.blank && (
          <> · <button type="button" className="iv-link" onClick={m.resetText}>Reset to the artist&apos;s wording</button></>
        )}
      </p>
      {text.length > 3600 && (
        <p className="iv-count" data-over={text.length > PROMPT_MAX || undefined}>
          {text.length.toLocaleString("en-US")} / {PROMPT_MAX.toLocaleString("en-US")}
        </p>
      )}
    </>
  );
}

/**
 * [ ]: the sentence with each value written in. A text value is edited in
 * place (committed on blur or Enter, Esc puts it back), an empty one shows
 * its label as a placeholder, never as a value; a checkbox toggles, a choice
 * opens its options, and a multi-choice or a slider goes to its field.
 */
function Inline({ model: m, segments }: { model: ImageViewModel; segments: Segment[] }) {
  const named = new Set<string>();
  return (
    <>
      <div className="iv-inline">
        {segments.map((s, i) => {
          if (s.kind === "text") return s.text;
          if (s.kind === "ref") {
            return (
              <span key={i} className="iv-tok iv-tok--ref" title={`Your reference image ${s.n}`} data-missing={s.n > m.refs.length || undefined}>
                {s.text}
              </span>
            );
          }
          const value = m.values[s.key] ?? "";
          const label = s.variable?.label || s.name;
          // The first token of a field is where Generate points.
          const at = named.has(s.key) ? undefined : s.key;
          named.add(s.key);
          const kind = s.variable ? fieldKind(s.variable) : "text";
          if (kind === "text") {
            const commit = (e: FocusEvent<HTMLSpanElement>) => {
              const v = e.currentTarget.textContent?.trim() ?? "";
              if (v !== value) m.setValue(s.key, v);
              m.release(s.key);
            };
            const key = (e: KeyboardEvent<HTMLSpanElement>) => {
              if (e.key === "Enter") e.preventDefault();
              else if (e.key === "Escape") {
                e.stopPropagation();
                e.currentTarget.textContent = value;
              } else return;
              e.currentTarget.blur();
            };
            const paste = (e: ClipboardEvent<HTMLSpanElement>) => {
              e.preventDefault();
              document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " "));
            };
            return (
              // Keyed by its value: a commit remounts it rather than fighting the DOM.
              <span key={`${i}:${value}`} className="iv-tok" role="textbox" aria-label={label} title={`${label} · click to edit`}
                contentEditable suppressContentEditableWarning spellCheck={false} data-placeholder={label} data-iv-field={at}
                onBlur={commit} onKeyDown={key} onPaste={paste}>
                {value}
              </span>
            );
          }
          if (kind === "check") {
            const on = value === "true";
            return (
              <button key={i} type="button" className="iv-tok" data-off={!on || undefined} aria-pressed={on} data-iv-field={at}
                title={on ? "Click to leave it out" : "Click to put it in"} onClick={() => m.setValue(s.key, on ? "false" : "true")}>
                {sendValue(s.variable, "true")}
              </button>
            );
          }
          const options = s.variable?.options ?? [];
          if (kind === "choice") {
            return (
              <span key={i} className="iv-tok-menu" data-iv-field={at}>
                <PillMenu ariaLabel={label} title={label} value={value || null} onPick={(v) => m.setValue(s.key, v)}
                  trigger={<span>{options.find((o) => o.promptValue === value)?.visibleName || label}</span>}
                  options={options.map((o) => ({ key: o.promptValue, label: o.visibleName }))} />
              </span>
            );
          }
          return (
            <button key={i} type="button" className="iv-tok" data-iv-field={at} title={`${label} · change it below`}
              onClick={() => {
                m.setView("text");
                focusField(s.key);
              }}>
              {value || label}
            </button>
          );
        })}
      </div>
      <p className="iv-hint">Variables written out · click a highlighted value to change it</p>
    </>
  );
}

function Fields({ model: m }: { model: ImageViewModel }) {
  if (!m.fields.length) return null;
  return (
    <div className="iv-fields">
      {m.text !== null && (
        <div className="iv-sec-head">
          <span className="iv-label">Variables</span>
          <span className="iv-sub">from the [brackets] above</span>
        </div>
      )}
      {m.fields.map((f) => (
        <div key={f.key} data-iv-field={f.key}>
          <VariableField variable={asVariable(f)} value={m.values[f.key] ?? ""} onChange={(v) => m.setValue(f.key, v)}
            growOnly={m.growOnly(f.key)} onUserInput={() => m.release(f.key)}
            // A premium value travels as typed, and the server takes 300 characters (VALUE_MAX).
            maxLength={m.premium ? 300 : undefined}
            onCopy={() => copyText(sendValue(f.variable, m.values[f.key]), `Copied ${f.label}`)} />
        </div>
      ))}
    </div>
  );
}

/** A premium prompt: the price where the text would be (the text never reaches the client), then the fields. */
function Locked({ model: m }: { model: ImageViewModel }) {
  if (m.textMissing) {
    return (
      <section className="iv-prompt">
        <span className="iv-label">Prompt · free</span>
        <p className="iv-note">The prompt text could not load. Try again later.</p>
      </section>
    );
  }
  const total = m.guest ? null : m.quote ? `$${m.quote.totalUsd}` : null;
  return (
    <section className="iv-prompt">
      <div className="iv-sec-head">
        <span className="iv-label">Variables</span>
        {m.fields.length > 0 && (
          <button type="button" className="iv-copy kit-hit" aria-label="Copy your values" title="Copy your values" onClick={m.copyPrompt}>
            <Copy size={12} strokeWidth={2.2} aria-hidden />
          </button>
        )}
      </div>
      <div className="iv-lock">
        <div className="iv-lock-price">
          <span className="iv-lock-line">
            <span className="iv-lock-total">
              {total ?? (m.quotePending ? <Loader2 className="iv-spin" size={22} aria-label="Getting the price" /> : "—")}
            </span>
            <span className="iv-lock-per">per image</span>
          </span>
          <span className="iv-lock-note">
            {m.guest ? "Sign in to see the price" : !m.setup ? "Pick a generator to see the price" : "Charged only when the image arrives · failed renders cost nothing"}
          </span>
        </div>
        <span className="iv-lock-pill"><Lock size={11} strokeWidth={2.2} aria-hidden />Prompt locked</span>
      </div>
      <Fields model={m} />
    </section>
  );
}
