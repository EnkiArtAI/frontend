"use client";

import { useEffect, useRef } from "react";

type CurtainImageProps = {
  after: string;
  before: string | null;
  alt: string;
  className?: string;
};

/* --cut is the horizontal position of the diagonal edge, 0 = left edge,
   1 = right edge. The edge leans 22% each way, so the layer is fully hidden
   at -0.25 and fully shown at 1.25. */
const REST = -0.25;
const HALF = 0.5;
const STEP = 0.15;
const clamp = (value: number) => Math.max(REST, Math.min(1.25, value));

/**
 * The output image with the input image behind a diagonal curtain. The
 * pointer drives the edge on hover, touch drags it sideways (vertical
 * scrolling stays free), the arrow keys step it when the host is focused,
 * and prefers-reduced-motion shows a static half split.
 *
 * The interaction surface is the nearest ancestor carrying
 * `data-curtain-host` (the card, which is what the keyboard focuses) or
 * this element when none exists. The before layer never receives pointer
 * events, so the host's own click keeps working.
 */
export default function CurtainImage({ after, before, alt, className }: CurtainImageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<SVGLineElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const layer = layerRef.current;
    const line = lineRef.current;
    if (!root || !layer || !line) return;

    let cut = REST;
    let frame = 0;
    const paint = () => {
      frame = 0;
      layer.style.setProperty("--cut", String(cut));
      line.setAttribute("x1", String(cut * 100 + 22));
      line.setAttribute("x2", String(cut * 100 - 22));
      root.classList.toggle("is-open", cut > REST);
    };
    const set = (value: number, live: boolean) => {
      cut = clamp(value);
      layer.classList.toggle("is-live", live);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      set(HALF, false);
      return () => cancelAnimationFrame(frame);
    }

    const host = root.closest<HTMLElement>("[data-curtain-host]") ?? root;
    const fromEvent = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      return rect.width ? ((event.clientX - rect.left) / rect.width) * 1.5 + REST : cut;
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || event.buttons) set(fromEvent(event), true);
    };
    const onEnter = (event: PointerEvent) => {
      host.addEventListener("pointermove", onMove);
      if (event.pointerType === "mouse") set(fromEvent(event), true);
    };
    const reset = () => set(REST, false);
    const onLeave = () => {
      host.removeEventListener("pointermove", onMove);
      reset();
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") reset();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        set(Math.max(cut, 0) + STEP, false);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        set(cut - STEP, false);
      }
    };

    host.addEventListener("pointerenter", onEnter);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    host.addEventListener("keydown", onKey);
    host.addEventListener("blur", reset);
    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener("pointerenter", onEnter);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
      host.removeEventListener("keydown", onKey);
      host.removeEventListener("blur", reset);
    };
  }, [before]);

  const curtain = className ? `enki-curtain ${className}` : "enki-curtain";

  return (
    <div ref={rootRef} className={curtain}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={after} alt={alt} />
      {before && (
        <>
          <div ref={layerRef} className="enki-curtain-before" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={before} alt="" />
            <svg viewBox="0 0 100 100" preserveAspectRatio="none">
              <line ref={lineRef} x1={REST * 100 + 22} y1="0" x2={REST * 100 - 22} y2="100" />
            </svg>
            <span className="enki-curtain-tag">Input</span>
          </div>
          <span className="enki-curtain-tag enki-curtain-tag-out" aria-hidden="true">Output</span>
        </>
      )}
    </div>
  );
}
