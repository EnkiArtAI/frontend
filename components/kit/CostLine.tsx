"use client";

import type { ReactNode } from "react";
import "./kit-controls.css";

/**
 * The line under Generate: what the render costs and who gets what on the
 * left, the balance on the right. A short balance turns red and offers to
 * add funds; Generate stays pressable either way (handoff §0).
 */
export default function CostLine({ left, balance }: {
  left: ReactNode;
  /** Null hides the balance (guest, free host, no Solana address). */
  balance: { text: string; short: boolean; onAddFunds: () => void } | null;
}) {
  return (
    <div className="kit-cost kit-focus">
      <span className="kit-cost-left">{left}</span>
      {balance && (
        <button type="button" className="kit-cost-bal kit-hit" title="Add funds" data-short={balance.short || undefined}
          onClick={balance.onAddFunds}>
          Balance <span className="kit-cost-amt">{balance.text}</span>
          {balance.short && <> · <span className="kit-cost-add">Add funds</span></>}
        </button>
      )}
    </div>
  );
}
