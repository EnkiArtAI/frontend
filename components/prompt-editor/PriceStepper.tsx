"use client";

import { useRef, useState } from "react";
import { priceInputText, priceOf, priceTextFor, ROLL_TIMING, rollKeyframes, stepPrice } from "@/lib/editor/price-input";

/**
 * The Premium price: −/+ a cent at a time down to one cent, and the figure
 * itself as a field, so $2.00 is typed rather than tapped 193 times. The
 * server keeps whole cents, so leaving the field rounds to them. An arrow
 * press rolls the figure up or down (rollKeyframes).
 */
export default function PriceStepper({ price, onPrice }: { price: number; onPrice: (price: number) => void }) {
  // What is being typed; null while the field is not being edited.
  const [text, setText] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const down = stepPrice(price, -1);
  const up = stepPrice(price, 1);
  const press = (next: number | null, direction: 1 | -1) => {
    if (next === null) return;
    onPrice(next);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) field.current?.animate(rollKeyframes(direction), ROLL_TIMING);
  };
  return (
    <div className="pe-price" title="Your price per image. People pay it on top of the generator cost.">
      <button type="button" className="kit-hit" aria-label="A cent less" disabled={down === null}
        onClick={() => press(down, -1)}>−</button>
      <label className="pe-price-val">
        $
        <input ref={field} data-pe-field="price" data-native-undo inputMode="decimal" size={5} aria-label="Price per image in dollars"
          value={text === null ? price.toFixed(2) : priceTextFor(text, price)}
          onFocus={() => setText(price.toFixed(2))}
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
      </label>
      <button type="button" className="kit-hit" aria-label="A cent more" disabled={up === null}
        onClick={() => press(up, 1)}>+</button>
    </div>
  );
}
