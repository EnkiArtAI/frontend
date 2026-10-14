"use client";

import { Fragment, useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import AutosizeTextarea from "./AutosizeTextarea";
import type { Token } from "@/lib/editor/prompt-tokens";
import { variableRange, type VariableRange } from "@/lib/editor/selection-variable";
import { COARSE } from "@/lib/ui/kit/breakpoints";
import { mirrorRuns, pillSpot } from "@/lib/ui/kit/mirror";
import "./kit-media.css";

/** The selection is read again this long after it seems to settle: a click into an old selection must not raise a phantom pill (selection-variable.ts). */
const SETTLE_MS = 80;

/** The look of one token, for `renderToken` to spread onto its own element. */
export type TokenLook = { className: string; children: ReactNode };

type Pill = { range: VariableRange; left: number; top: number; text: string };

/**
 * A prompt field whose [tokens] are coloured: a real textarea with
 * transparent text under an aria-hidden mirror that prints the same text
 * with the same metrics (one rule styles both; a surface sets --kit-fs,
 * --kit-lh, --kit-pad and --kit-radius). The mirror's text area leaves out
 * the textarea's scrollbar and scrolls with it, and a token changes only
 * background and colour, so the caret never drifts from the glyphs.
 *
 * With `selectionPill`, selecting a word shows "+ Variable" at the
 * selection; its click hands the checked range to the caller, which makes
 * the variable.
 */
export default function PromptMirror({
  value, onChange, tokens, missingRefs, min, max, growOnly, onUserInput, placeholder, selectionPill, renderToken, dragging, className, ref, ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "onSelect" | "onBlur" | "onKeyDown" | "onScroll" | "className"> & {
  value: string;
  /** The new text and the caret after it. */
  onChange: (value: string, caret: number) => void;
  /** parseTokens(value) in the surface's reference style. */
  tokens: readonly Token[];
  /** Reference numbers that have no image: their tokens get a danger ring. */
  missingRefs?: readonly number[];
  min: number;
  max: number;
  growOnly: boolean;
  onUserInput?: () => void;
  placeholder?: string;
  selectionPill?: {
    onCreate: (range: VariableRange) => void;
    /** Below the line instead of above it; a touch screen's default. */
    below?: boolean;
  };
  /** Draws a token itself (drag handles); spread `look` onto it so the metrics stay the mirror's. Tokens then take the pointer. */
  renderToken?: (t: Token, i: number, look: TokenLook) => ReactNode;
  /** A token drag is under way: the mirror takes the pointer and the border turns ember. */
  dragging?: boolean;
  className?: string;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pill, setPill] = useState<Pill | null>(null);
  useImperativeHandle(ref, () => ta.current as HTMLTextAreaElement, []);

  const scrollWith = () => {
    if (mirror.current && ta.current) mirror.current.scrollTop = ta.current.scrollTop;
  };
  // New text may move the textarea's scroll without a scroll event.
  useLayoutEffect(() => {
    if (mirror.current && ta.current) mirror.current.scrollTop = ta.current.scrollTop;
  }, [value]);

  // Every size change, a scrollbar coming or going included, re-measures the inset.
  useEffect(() => {
    const t = ta.current;
    if (!t) return;
    const ro = new ResizeObserver(() => {
      const s = getComputedStyle(t);
      const bar = t.offsetWidth - t.clientWidth - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
      for (const m of [mirror.current, probe.current]) m?.style.setProperty("right", `${Math.max(0, bar)}px`);
      if (mirror.current) mirror.current.scrollTop = t.scrollTop;
    });
    ro.observe(t);
    return () => ro.disconnect();
  }, []);

  // The probe is a hidden copy of the mirror holding the text up to the
  // selection end and a marker, which lands where the selection ends.
  const check = () => {
    const t = ta.current;
    const p = probe.current;
    const range = t && p && document.activeElement === t ? variableRange(t.value, t.selectionStart, t.selectionEnd) : null;
    if (!t || !p || !range) return setPill(null);
    p.textContent = t.value.slice(0, range.end);
    const mark = p.appendChild(document.createElement("span"));
    mark.textContent = "\u200b";
    setPill({
      range,
      text: t.value,
      ...pillSpot({
        x: mark.offsetLeft,
        y: mark.offsetTop,
        scrollTop: t.scrollTop,
        width: t.clientWidth,
        lineHeight: parseFloat(getComputedStyle(t).lineHeight) || 0,
        below: selectionPill?.below ?? window.matchMedia(COARSE).matches,
      }),
    });
  };
  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(check, SETTLE_MS);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setPill(null);
  };

  // iOS reports a selection dragged by its handles only through selectionchange.
  const onSelectionChange = useEffectEvent(() => {
    if (document.activeElement === ta.current) schedule();
  });
  const pillOn = !!selectionPill;
  useEffect(() => {
    if (!pillOn) return;
    const on = () => onSelectionChange();
    document.addEventListener("selectionchange", on);
    return () => {
      document.removeEventListener("selectionchange", on);
      clearTimeout(timer.current);
    };
  }, [pillOn]);

  // A pill measured for other text is gone: the text changed under it.
  const shown = pillOn && pill?.text === value ? pill : null;

  return (
    <div className={className ? `kit-pm ${className}` : "kit-pm"} data-dragging={dragging || undefined}>
      <AutosizeTextarea ref={ta} {...rest} className="kit-pm-text" value={value} min={min} max={max} growOnly={growOnly}
        onUserInput={onUserInput} placeholder={placeholder}
        onChange={(v) => onChange(v, ta.current?.selectionStart ?? v.length)}
        onScroll={scrollWith}
        onSelect={pillOn ? schedule : undefined}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !shown) return;
          e.stopPropagation();
          hide();
        }} />
      <div ref={mirror} className="kit-pm-mirror" aria-hidden data-interactive={renderToken ? "" : undefined}>
        {mirrorRuns(value, tokens, missingRefs).map(({ text, token, i = 0, missing }, k) => {
          if (!token) return text;
          const look: TokenLook = {
            className: `kit-tok kit-tok--${token.kind}${missing ? " is-missing" : ""}`,
            children: text.startsWith("[") && text.endsWith("]")
              ? <><span className="kit-tok-br">[</span>{text.slice(1, -1)}<span className="kit-tok-br">]</span></>
              : text,
          };
          return <Fragment key={k}>{renderToken ? renderToken(token, i, look) : <span {...look} />}</Fragment>;
        })}
      </div>
      <div ref={probe} className="kit-pm-mirror kit-pm-probe" aria-hidden />
      {shown && selectionPill && (
        <button type="button" className="kit-pm-pill" style={{ left: shown.left, top: shown.top }}
          // Keeps the focus and the selection in the field.
          onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            hide();
            selectionPill.onCreate(shown.range);
          }}>
          + Variable
        </button>
      )}
    </div>
  );
}
