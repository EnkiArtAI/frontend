"use client";

import { useCallback, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";

const KEY = "enki-editor-split";
const DEFAULT = 520;
/** Craft is never narrower than this, and Verify keeps VERIFY_MIN. */
const MIN = 360;
const VERIFY_MIN = 420;
const STEP = 16;

const noSubscribe = () => () => {};
function readSplit(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v >= MIN ? v : null;
  } catch {
    return null;
  }
}
function writeSplit(v: number | null) {
  try {
    if (v === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(v)));
  } catch {
    /* the divider works without storage */
  }
}

/** Between MIN and what leaves Verify its room; as asked until the body has been measured. */
const clampSplit = (v: number, width: number) => (width ? Math.max(MIN, Math.min(v, width - VERIFY_MIN)) : v);

export type Split = { value: number; min: number; max: number; clamp: (v: number) => number; set: (v: number | null) => void };

/**
 * Where Craft ends, from 1024 px (handoff §4: a draggable divider whose
 * position is kept). `measure` goes on the body as its ref: a narrower
 * window re-clamps the value, which the body takes as --pe-split.
 */
export function useSplit(): { measure: (el: HTMLElement | null) => (() => void) | undefined; split: Split } {
  const stored = useSyncExternalStore(noSubscribe, readSplit, () => null);
  const [own, setOwn] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const measure = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return {
    measure,
    split: {
      value: clampSplit(own ?? stored ?? DEFAULT, width),
      min: MIN,
      max: Math.max(MIN, width - VERIFY_MIN),
      clamp: (v: number) => clampSplit(v, width),
      // A position the user chose is kept for the next visit; null goes back to the default and forgets it.
      set: (v: number | null) => {
        setOwn(v === null ? DEFAULT : clampSplit(v, width));
        writeSplit(v === null ? null : clampSplit(v, width));
      },
    },
  };
}

/**
 * The handle between Craft and Verify: drag it, double-click to reset, or
 * ← → (16 px) and Home / End from the keyboard. While it is dragged only the
 * body's --pe-split moves, so the editor does not re-render on every pixel.
 */
export default function SplitDivider({ split }: { split: Split }) {
  const grab = useRef<{ body: HTMLElement; offset: number; left: number; at: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const start = (e: PointerEvent<HTMLDivElement>) => {
    const body = e.currentTarget.parentElement;
    if (e.button !== 0 || !body) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const left = body.getBoundingClientRect().left;
    grab.current = { body, offset: split.value - (e.clientX - left), left, at: split.value };
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g) return;
    g.at = split.clamp(e.clientX - g.left + g.offset);
    g.body.style.setProperty("--pe-split", `${g.at}px`);
  };
  const stop = () => {
    const g = grab.current;
    grab.current = null;
    setDragging(false);
    if (g) split.set(g.at);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const to: Record<string, number> = { ArrowLeft: split.value - STEP, ArrowRight: split.value + STEP, Home: split.min, End: split.max };
    if (!(e.key in to)) return;
    e.preventDefault();
    split.set(to[e.key]);
  };

  return (
    <div className="pe-split" role="separator" aria-orientation="vertical" aria-label="Resize Craft and Verify"
      aria-valuenow={Math.round(split.value)} aria-valuemin={split.min} aria-valuemax={split.max} tabIndex={0}
      title="Drag to resize · double-click to reset" data-dragging={dragging || undefined}
      onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop}
      onDoubleClick={() => split.set(null)} onKeyDown={keys} />
  );
}
