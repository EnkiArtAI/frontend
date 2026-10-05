/**
 * The text of a price field, kept apart from the price it stands for.
 *
 * A field bound to the number alone cannot hold "0", "0." or "0.0": each is
 * the number 0, the field is written back as empty, and the digits typed so
 * far are gone. Typing 0.05 then leaves a lone 5: a price of $5.00.
 */

/** What may stand in a price field: digits and one kind of decimal mark. */
export function priceInputText(raw: string): string {
  return raw.replace(/,/g, ".").replace(/[^0-9.]/g, "");
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
