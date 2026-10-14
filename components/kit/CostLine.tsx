"use client";

import type { ReactNode } from "react";
import "./kit-controls.css";

/**
 * The line under Generate: what keeps a render from going, or a free
 * generator's allowance. Nothing for a paid render, and never the balance:
 * a short one is on the button itself (Kev, 2026-10-13).
 */
export default function CostLine({ left }: { left: ReactNode }) {
  return (
    <div className="kit-cost kit-focus">
      <span className="kit-cost-left">{left}</span>
    </div>
  );
}
