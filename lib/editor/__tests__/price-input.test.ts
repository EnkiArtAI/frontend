import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { priceInputText, priceOf, priceTextFor, stepPrice } from "@/lib/editor/price-input";

/**
 * The mobile sheet is the whole editor on a phone, and a release sends what
 * it holds. Its price field could not hold what was typed into it.
 */
const SHEET = readSource(join(__dirname, "..", "..", "..", "components", "EnkiMobileGenerateModal.tsx"));

describe("the price typed into the sheet", () => {
  /** Types key by key as the field does: the text is kept, the price follows it. */
  const type = (keys: string) => {
    let text = "";
    let price = 0;
    for (const key of keys) {
      text = priceInputText(text + key);
      price = priceOf(text);
      // The field shows what the sync leaves for the price it was just given.
      text = priceTextFor(text, price);
    }
    return { text, price };
  };

  it("is the price that was typed, zeros included", () => {
    // Bound to the number alone the field dropped "0", "0." and "0.0": 0.05 became $5.00.
    expect(type("0.05")).toEqual({ text: "0.05", price: 0.05 });
    expect(type("0.01")).toEqual({ text: "0.01", price: 0.01 });
    expect(type("0.5")).toEqual({ text: "0.5", price: 0.5 });
    expect(type("10.50")).toEqual({ text: "10.50", price: 10.5 });
    expect(type("2")).toEqual({ text: "2", price: 2 });
  });

  it("keeps a text that stands for no price yet", () => {
    for (const text of ["0", "0.", "0.0", ".", ""]) {
      expect(priceOf(text)).toBe(0);
      expect(priceTextFor(text, 0)).toBe(text);
    }
  });

  it("takes a comma as the decimal mark and nothing that is no digit", () => {
    expect(priceInputText("0,05")).toBe("0.05");
    expect(priceInputText("$ 1.50 usdc")).toBe("1.50");
    expect(priceInputText("-3")).toBe("3");
    expect(priceInputText("1e9")).toBe("19");
  });

  it("follows a price set from outside: a restored draft, a reset after a release", () => {
    expect(priceTextFor("", 2.5)).toBe("2.5");
    expect(priceTextFor("0.05", 2.5)).toBe("2.5");
    expect(priceTextFor("5", 0)).toBe("");
    // The same price typed another way is left as typed.
    expect(priceTextFor("2.50", 2.5)).toBe("2.50");
  });

  it("is what the sheet's field holds and reports", () => {
    const field = SHEET.slice(SHEET.lastIndexOf("<input", SHEET.indexOf('className="mobile-modal-price-input"')), SHEET.indexOf("USDC / render"));
    expect(field).toContain('type="text"');
    expect(field).toContain('inputMode="decimal"');
    expect(field).toContain("value={priceTextFor(priceText, priceVal)}");
    expect(field).toContain("const text = priceInputText(e.target.value);");
    expect(field).toContain("setPriceText(text);");
    expect(field).toContain("onPrice(priceOf(text));");
    expect(field).not.toContain('type="number"');
  });
});

describe("an arrow press on the price", () => {
  // Kev, 2026-10-05: the arrows count in cents; a finer price, down to $0.0001, is typed.
  it("adds or takes one cent", () => {
    expect(stepPrice(0.07, 1)).toBe(0.08);
    expect(stepPrice(0.07, -1)).toBe(0.06);
    expect(stepPrice(1, 1)).toBe(1.01);
    expect(stepPrice(0.29, 1)).toBe(0.3);
    expect(stepPrice(0.1, 1)).toBe(0.11);
  });

  it("starts an empty price at one cent", () => {
    expect(stepPrice(0, 1)).toBe(0.01);
  });

  it("stops at one cent", () => {
    // It landed on $0.0001 here, and every press after that stayed off the cents.
    expect(stepPrice(0.01, -1)).toBeNull();
    expect(stepPrice(0.02, -1)).toBe(0.01);
    expect(stepPrice(0.015, -1)).toBe(0.01);
  });

  it("never raises a price by a press down", () => {
    expect(stepPrice(0, -1)).toBeNull();
    expect(stepPrice(0.0005, -1)).toBeNull();
    expect(stepPrice(0.0001, -1)).toBeNull();
  });

  it("steps a typed price from where it stands", () => {
    expect(stepPrice(0.0705, 1)).toBe(0.0805);
    expect(stepPrice(0.0705, -1)).toBe(0.0605);
    expect(stepPrice(0.0005, 1)).toBe(0.0105);
  });
});
