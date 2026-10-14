"use client";

import { useRef, type MouseEvent } from "react";
import { acceptPress } from "@/lib/ui/kit/controls";
import "./kit-controls.css";

/**
 * Generate with its price chip. Dimmed is only a look: the press still
 * reaches the surface, which explains what is missing (R11). A second press
 * within 350 ms is dropped, so a double click never pays twice.
 */
export default function GenerateButton({ label, chip, chipPending = false, dimmed, onPress, size, short = null }: {
  label: string;
  /** "$0.147", "$0.00", or null for no chip. */
  chip: string | null;
  /** The quote for new settings is on its way: the chip pulses. */
  chipPending?: boolean;
  dimmed: boolean;
  onPress: () => void;
  /** "bar": inline with the settings pills; "block": the full width. */
  size: "bar" | "block";
  /** The balance ("$0.00") while it is below the price: the button turns red
      and shows it beside the price; the surface makes the press open Add
      funds (Kev, 2026-10-13). Null otherwise. */
  short?: string | null;
}) {
  const last = useRef<number | null>(null);
  const press = (e: MouseEvent) => {
    if (!acceptPress(last.current, e.timeStamp)) return;
    last.current = e.timeStamp;
    onPress();
  };
  return (
    <button type="button" className={`kit-gen kit-gen--${size} kit-hit kit-focus`} aria-disabled={dimmed || undefined}
      data-short={short !== null || undefined} title={short === null ? undefined : "Your balance is below the price · opens Add funds"} onClick={press}>
      {label}
      {(chip !== null || chipPending) && (
        <span className="kit-gen-chip" data-pending={chipPending || undefined}>
          {short !== null && <span className="kit-gen-short">Balance {short}</span>}
          {chip ?? "…"}
        </span>
      )}
    </button>
  );
}
