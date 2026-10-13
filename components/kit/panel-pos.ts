"use client";

import { useEffect, useRef, useState } from "react";
import { outsideScroll } from "@/lib/ui/kit/controls";

/** Fixed-position coordinates for an open panel, measured from the trigger. */
export interface PanelPos {
  left: number;
  minWidth: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Shared popover plumbing for the ratio-styled selects (ratio, quality).
 *
 * The panel is position:FIXED and rendered through a PORTAL on
 * document.body. Fixed because an absolute panel inside the scrollable
 * settings rail extended the rail's scroll extent (Kev, 2026-08-24:
 * "scrollable im element selbst statt die ganze UI"); portaled because the
 * detail panel is itself a stacking context at z-index 162 UNDER the shell
 * rail — no child z-index can beat the rail from inside it, so the open
 * panel rendered behind the left menu (Kev, 2026-08-24, screenshot). The
 * panel scrolls internally only when the viewport cannot hold the full
 * list, and closes on any other scroll so it can never sit detached. With
 * `follows` (a menu that stays open while its rows are ticked) it moves with
 * its trigger on such a scroll instead (lib/ui/kit/controls outsideScroll).
 */
export function usePanelPos(itemCount: number, follows = false) {
  const [pos, setPos] = useState<PanelPos | null>(null);
  const trigRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** The PORTALED panel — outside the wrap in the DOM, so the outside-click
      check must consult both or option clicks would close before they land. */
  const panelRef = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    };
    // The capture sees the panel's own scroll too: that one is reading the list.
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (outsideScroll(follows, trigRef.current?.getBoundingClientRect() ?? null, window.innerHeight) === "close") return close();
      // A new object: the menu's layout effect places the panel at its trigger again.
      setPos((p) => p && { ...p });
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, follows]);

  const toggle = () => {
    if (open) { setPos(null); return; }
    const r = trigRef.current?.getBoundingClientRect();
    if (!r) return;
    const panelH = itemCount * 30 + 12;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    // Open where the full list fits; when neither side holds it, take the
    // larger side and let the panel scroll inside itself.
    const up = below < panelH && above > below;
    setPos({
      left: r.left,
      minWidth: r.width,
      top: up ? undefined : r.bottom + 4,
      bottom: up ? window.innerHeight - r.top + 4 : undefined,
      maxHeight: Math.max(90, Math.min(panelH, (up ? above : below))),
    });
  };

  return { pos, open, toggle, close: () => setPos(null), trigRef, wrapRef, panelRef };
}

/** Inline style applying a PanelPos to the .enki-ratio-panel element. */
export function panelStyle(pos: PanelPos): React.CSSProperties {
  return {
    position: "fixed",
    left: pos.left,
    top: pos.top,
    bottom: pos.bottom,
    minWidth: pos.minWidth,
    maxHeight: pos.maxHeight,
    overflowY: "auto",
  };
}
