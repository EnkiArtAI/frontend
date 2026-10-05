/**
 * The text of a price field, kept apart from the price it stands for.
 *
 * A field bound to the number alone cannot hold "0", "0." or "0.0": each is
 * the number 0, the field is written back as empty, and the digits typed so
 * far are gone. Typing 0.05 then leaves a lone 5: a price of $5.00.
 */

/** What may stand in a price field: digits and one decimal mark, a comma counting as one. */
export function priceInputText(raw: string): string {
  const [whole, ...rest] = raw.replace(/,/g, ".").replace(/[^0-9.]/g, "").split(".");
  return rest.length ? `${whole}.${rest.join("")}` : whole;
}

/** The price a field's text stands for; no number yet is 0. */
export function priceOf(text: string): number {
  const n = parseFloat(text);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The text to show for `price`: what was typed while it still stands for that
 * price, otherwise the price itself (it was set from outside: a restored
 * draft, a reset).
 */
export function priceTextFor(text: string, price: number): string {
  return priceOf(text) === price ? text : price ? String(price) : "";
}

/** What one arrow press adds or takes, and the lowest price the arrows reach. */
export const PRICE_STEP = 0.01;

/**
 * The price one arrow press away, or null when the press changes nothing.
 * The arrows count in cents (Kev, 2026-10-05) and stop at one cent: a press
 * down from $0.01 used to land on $0.0001, and every press after that stayed a
 * hundredth of a cent off the cents. A price below a cent is typed, and a
 * press down never raises it.
 */
export function stepPrice(current: number, direction: 1 | -1): number | null {
  const next = Math.max(PRICE_STEP, parseFloat((current + direction * PRICE_STEP).toFixed(4)));
  return next === current || (direction < 0 && next > current) ? null : next;
}
