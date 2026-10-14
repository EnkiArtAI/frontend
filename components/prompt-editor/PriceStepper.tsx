"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { changedDigits, priceInputText, priceOf, priceTextFor, ROLL_TIMING, rollKeyframes, stepPrice } from "@/lib/editor/price-input";

/**
 * The Premium price: −/+ a cent at a time down to one cent, and the figure
 * itself as a field, so $2.00 is typed rather than tapped 193 times. The
 * server keeps whole cents, so leaving the field rounds to them.
 *
 * While the field is not being typed in, its digits are drawn by one span
 * each over the (then transparent) input, in the same mono font, so an arrow
 * press can roll only the digits that changed (Kev, 2026-10-13).
 */
export default function PriceStepper({ price, onPrice }: { price: number; onPrice: (price: number) => void }) {
  // What is being typed; null while the field is not being edited.
  const [text, setText] = useState<string | null>(null);
  const digits = useRef<Array<HTMLSpanElement | null>>([]);
  // The press that is waiting for its new figure to be on screen.
  const pending = useRef<{ from: string; direction: 1 | -1 } | null>(null);
  const shown = price.toFixed(2);
  const down = stepPrice(price, -1);
  const up = stepPrice(price, 1);

  const press = (next: number | null, direction: 1 | -1) => {
    if (next === null) return;
    pending.current = { from: shown, direction };
    onPrice(next);
  };
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const i of changedDigits(p.from, shown)) digits.current[i]?.animate(rollKeyframes(p.direction), ROLL_TIMING);
  }, [shown]);

  return (
    <div className="pe-price" title="Your price per image. People pay it on top of the generator cost.">
      <button type="button" className="kit-hit" aria-label="A cent less" disabled={down === null}
        onClick={() => press(down, -1)}>−</button>
      <label className="pe-price-val">
        $
        <span className="pe-price-field" data-typing={text !== null || undefined}>
          <input data-pe-field="price" data-native-undo inputMode="decimal" size={5} aria-label="Price per image in dollars"
            value={text === null ? shown : priceTextFor(text, price)}
            onFocus={() => setText(shown)}
            onChange={(e) => {
              const next = priceInputText(e.target.value);
              setText(next);
              onPrice(priceOf(next));
            }}
            onBlur={() => {
              setText(null);
              const cents = Math.round(price * 100) / 100;
              if (cents !== price) onPrice(cents);
            }} />
          {text === null && (
            <span className="pe-price-digits" aria-hidden>
              {[...shown].map((c, i) => <span key={i} ref={(el) => { digits.current[i] = el; }}>{c}</span>)}
            </span>
          )}
        </span>
      </label>
      <button type="button" className="kit-hit" aria-label="A cent more" disabled={up === null}
        onClick={() => press(up, 1)}>+</button>
    </div>
  );
}
