"use client";

import { useEffect, type ReactNode } from "react";
import { Icon } from "./icons";

/**
 * Standalone right-side menu panel. It appears (fades in — no slide) over the
 * main area, leaving the left menu fully usable, and closes with the X or Esc.
 * Hosts the existing page/components so every menu item shows on the right.
 */
export default function EnkiPanel({ title, onClose, children, full, hideClose }: { title: string; onClose: () => void; children: ReactNode; full?: boolean; hideClose?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className={"ek-panel-scrim" + (full ? " ek-panel-scrim--full" : "")} onClick={onClose}>
      <aside className={"ek-panel" + (full ? " ek-panel--full" : "")} onClick={(e) => e.stopPropagation()}>
        {/* No title bar — each panel brings its own serif headline; a floating
            X keeps the panel closable. hideClose drops it where the X only
            covered content (Kev, 2026-08-24: Hall of Fame) — ESC, scrim
            click and the menu still close the panel. */}
        {!hideClose && (
          <button className="ek-panel-x ek-panel-x--float" onClick={onClose} aria-label={`Close ${title}`}>
            <Icon name="x" size={18} stroke={2} />
          </button>
        )}
        <div className="ek-panel-body">{children}</div>
      </aside>
    </div>
  );
}
