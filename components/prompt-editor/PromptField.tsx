"use client";

import { useEffect, useEffectEvent, useRef, useState, type DragEvent, type PointerEvent } from "react";
import { Redo, Undo } from "lucide-react";
import PromptMirror from "@/components/kit/PromptMirror";
import { moveToken } from "@/lib/editor/move-token";
import { insertToken, parseTokens, snapIndex, type Token } from "@/lib/editor/prompt-tokens";
import type { VariableRange } from "@/lib/editor/selection-variable";

/** On a touch screen a token is lifted after this long a press; moving further than SLOP first is a scroll. */
const HOLD_MS = 400;
const SLOP = 8;
/** A mouse lifts a token as soon as it moves this far. */
const MOUSE_SLOP = 4;

type Marker = { index: number; left: number; top: number; height: number };
type Press = { token: Token; x: number; y: number; id: number; active: boolean; timer?: ReturnType<typeof setTimeout> };

type CaretApi = {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** The text index under a point of the mirror (Firefox has the one API, Chrome and Safari the other); null outside its text. */
function indexAt(mirror: HTMLElement, x: number, y: number): number | null {
  const d = document as unknown as CaretApi;
  const pos = d.caretPositionFromPoint?.(x, y);
  const range = pos ? null : d.caretRangeFromPoint?.(x, y);
  const node = pos?.offsetNode ?? range?.startContainer;
  if (!node || !mirror.contains(node)) return null;
  const r = document.createRange();
  r.setStart(mirror, 0);
  r.setEnd(node, pos?.offset ?? range?.startOffset ?? 0);
  return r.toString().length;
}

/** While a token is held the page must not scroll under the finger: set as it is lifted, before the next move. */
const still = (e: TouchEvent) => e.preventDefault();

/** Where index `i` of the mirror's text sits on screen. */
function rectAt(mirror: HTMLElement, i: number): DOMRect | null {
  const walk = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(), left = i; n; n = walk.nextNode()) {
    const len = n.textContent?.length ?? 0;
    if (left <= len) {
      const r = document.createRange();
      r.setStart(n, left);
      return r.getClientRects()[0] ?? r.getBoundingClientRect();
    }
    left -= len;
  }
  return null;
}

/**
 * The prompt: the kit's token-coloured mirror, its "+ Variable" pill, undo and
 * redo, and dragging. A token is dragged with the mouse at once and on a touch
 * screen after a 400 ms press (iOS has no HTML5 drag); a reference tile is
 * dragged in with HTML5 drag. Either way an ember marker shows where it lands,
 * snapped out of tokens and words (snapIndex), and one drop is one undo step.
 */
export default function PromptField({ value, refCount, min, max, growOnly, onUserInput, onEdit, onCreateVariable, onAddVariable, onFocus, history, refDrag }: {
  value: string;
  refCount: number;
  min: number;
  max: number;
  growOnly: boolean;
  onUserInput: () => void;
  /** The new text; a `key` folds keystrokes into one undo step. */
  onEdit: (prompt: string, key?: string) => void;
  onCreateVariable: (range: VariableRange) => void;
  onAddVariable: () => void;
  /** The field took focus: its caret is now where a reference tile inserts. */
  onFocus: () => void;
  history: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void };
  /** The token of a reference tile on its way here. */
  refDrag: string | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const press = useRef<Press | null>(null);
  // A drag happened: the click that follows the release is not a tap.
  const dragged = useRef(false);
  const [drag, setDrag] = useState<Token | null>(null);
  const [marker, setMarker] = useState<Marker | null>(null);
  const tokens = parseTokens(value);
  const missing = tokens.flatMap((t) => (t.kind === "ref" && t.n > refCount ? [t.n] : []));
  const shown = drag || refDrag ? marker : null;

  /** The marker for a drop at this point; none on the dragged token itself or outside the text. */
  const aim = (x: number, y: number, lifted?: Token) => {
    const m = wrap.current?.querySelector<HTMLElement>(".kit-pm-mirror:not(.kit-pm-probe)");
    const i = m ? indexAt(m, x, y) : null;
    const at = i === null ? null : snapIndex(value, Math.min(i, value.length), lifted);
    const rect = m && at !== null ? rectAt(m, at) : null;
    const box = wrap.current?.getBoundingClientRect();
    if (!rect || !box || at === null) return setMarker(null);
    if (marker?.index !== at) setMarker({ index: at, left: rect.left - box.left, top: rect.top - box.top, height: rect.height });
  };

  const end = () => {
    clearTimeout(press.current?.timer);
    document.removeEventListener("touchmove", still);
    press.current = null;
    setDrag(null);
    setMarker(null);
  };
  const lift = (p: Press, el: HTMLElement) => {
    try {
      el.setPointerCapture(p.id);
    } catch {
      return; // the finger is already up
    }
    p.active = true;
    dragged.current = true;
    document.addEventListener("touchmove", still, { passive: false });
    setDrag(p.token);
    navigator.vibrate?.(10);
  };
  const down = (t: Token) => (e: PointerEvent<HTMLElement>) => {
    dragged.current = false;
    if (e.button !== 0 || t.kind === "blank") return;
    const el = e.currentTarget;
    const p: Press = { token: t, x: e.clientX, y: e.clientY, id: e.pointerId, active: false };
    press.current = p;
    if (e.pointerType !== "mouse") p.timer = setTimeout(() => press.current === p && lift(p, el), HOLD_MS);
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p) return;
    if (p.active) return aim(e.clientX, e.clientY, p.token);
    const mouse = e.pointerType === "mouse";
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) <= (mouse ? MOUSE_SLOP : SLOP)) return;
    if (mouse) lift(p, e.currentTarget);
    else end();
  };
  const up = () => {
    const p = press.current;
    if (p?.active && marker) {
      const moved = moveToken(value, p.token.start, p.token.end, marker.index);
      if (moved) onEdit(moved.body);
    }
    end();
  };
  const caretAfter = (t: Token) => {
    if (dragged.current) return;
    ta.current?.focus();
    ta.current?.setSelectionRange(t.end, t.end);
  };

  // Esc puts a held token back.
  const cancel = useEffectEvent(end);
  useEffect(() => {
    if (!drag) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [drag]);
  useEffect(() => () => document.removeEventListener("touchmove", still), []);

  const tileOver = (e: DragEvent) => {
    if (!refDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    aim(e.clientX, e.clientY);
  };
  const tileDrop = (e: DragEvent) => {
    if (!refDrag) return;
    // Never the textarea's own drop, which would paste the token where the caret is.
    e.preventDefault();
    if (marker) onEdit(insertToken(value, marker.index, refDrag).text);
    setMarker(null);
  };

  const step = (can: boolean, run: () => void) => () => can && run();
  return (
    <section className="pe-prompt" aria-label="Prompt">
      <div className="pe-prompt-head">
        <span className="kit-label">Prompt</span>
        <span className="pe-hint pe-wide-only">Select text to make a variable · drag pills to move</span>
        <div className="pe-undo">
          <button type="button" className="kit-hit" title="Undo (⌘Z)" aria-label="Undo" aria-disabled={!history.canUndo || undefined}
            onClick={step(history.canUndo, history.undo)}>
            <Undo size={14} strokeWidth={2.2} aria-hidden />
          </button>
          <button type="button" className="kit-hit" title="Redo (⇧⌘Z)" aria-label="Redo" aria-disabled={!history.canRedo || undefined}
            onClick={step(history.canRedo, history.redo)}>
            <Redo size={14} strokeWidth={2.2} aria-hidden />
          </button>
        </div>
        <button type="button" className="pe-add pe-tabs-only kit-hit" onClick={onAddVariable}>+ Add variable</button>
      </div>
      <div ref={wrap} className="pe-field" onDragOver={tileOver} onDrop={tileDrop}
        onDragLeave={(e) => { if (!wrap.current?.contains(e.relatedTarget as Node | null)) setMarker(null); }}>
        <PromptMirror ref={ta} data-pe-field="prompt" aria-label="Prompt text"
          value={value} onChange={(v) => onEdit(v, "prompt")} onFocus={onFocus} tokens={tokens} missingRefs={missing}
          min={min} max={max} growOnly={growOnly} onUserInput={onUserInput}
          placeholder="Describe the image you want to sell as a prompt. Wrap anything the buyer should change in [brackets] — a [subject], a [mood]…"
          selectionPill={{ onCreate: onCreateVariable }}
          dragging={!!drag || !!refDrag}
          renderToken={(t, _i, look) => (
            <span {...look} data-dragged={drag?.start === t.start || undefined}
              title={t.kind === "blank" ? "Unnamed variable" : t.kind === "ref" ? `${t.name} · drag to move` : `Variable ${t.name} · drag to move`}
              onPointerDown={down(t)} onPointerMove={move} onPointerUp={up} onPointerCancel={end}
              onClick={() => caretAfter(t)} />
          )} />
        {shown && <span className="pe-marker" style={{ left: shown.left, top: shown.top, height: shown.height }} aria-hidden />}
      </div>
      <span className="pe-hint pe-tabs-only">Select text to make a variable · tap a reference to add it</span>
    </section>
  );
}
