"use client";

import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, type Ref, type TextareaHTMLAttributes } from "react";
import { nextHeight } from "@/lib/ui/kit/autosize";
import "./kit-media.css";

/**
 * A textarea that grows with its text between `min` and `max` px and then
 * scrolls inside (handoff §0 "Autosize-Regel"). While `growOnly` (values
 * loaded from an image, useGrowOnly) it never shrinks; typing reports
 * `onUserInput`, so the caller lets this field alone shrink again.
 *
 * Measured before paint on every change, again once the fonts have loaded,
 * and when its width changes (a narrower field needs more lines). 16 px on a
 * touch screen, so iOS does not zoom in on focus.
 */
export default function AutosizeTextarea({ value, onChange, min, max, growOnly, onUserInput, ref, className, style, ...rest }:
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
    value: string;
    onChange: (value: string) => void;
    min: number;
    max: number;
    growOnly: boolean;
    onUserInput?: () => void;
    ref?: Ref<HTMLTextAreaElement>;
  }) {
  const el = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => el.current as HTMLTextAreaElement, []);

  // A width change measures afresh: held fields may shrink to the new width.
  const fit = useEffectEvent((widthChanged: boolean) => {
    const ta = el.current;
    if (!ta) return;
    const prev = ta.offsetHeight;
    // Chrome counts a wrapped placeholder in scrollHeight: an empty value
    // field grew a line whenever "Example <name>" wrapped as the name was
    // typed, and the pane jumped with it (Kev, 2026-10-13). Measured without it.
    const placeholder = ta.placeholder;
    ta.placeholder = "";
    ta.style.height = "auto";
    const scrollHeight = ta.scrollHeight;
    ta.placeholder = placeholder;
    const next = nextHeight({ scrollHeight, prev, min, max, growOnly: growOnly && !widthChanged });
    ta.style.height = `${next.height}px`;
    ta.style.overflowY = next.overflowY;
  });

  useLayoutEffect(() => fit(false), [value, growOnly, min, max]);

  useEffect(() => {
    const ta = el.current;
    if (!ta) return;
    // Our own height changes resize it too; only a new width is a reason.
    let width = ta.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (ta.offsetWidth === width) return;
      width = ta.offsetWidth;
      fit(true);
    });
    ro.observe(ta);
    let live = true;
    void document.fonts.ready.then(() => live && fit(false));
    return () => {
      live = false;
      ro.disconnect();
    };
  }, []);

  return (
    <textarea ref={el} rows={1} {...rest} value={value}
      className={className ? `kit-autosize ${className}` : "kit-autosize"}
      style={{ minHeight: min, maxHeight: max, ...style }}
      onChange={(e) => {
        onUserInput?.();
        onChange(e.target.value);
      }} />
  );
}
