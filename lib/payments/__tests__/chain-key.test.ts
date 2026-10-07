import { describe, it, expect } from "vitest";
import { isChainKey, PAYMENT_CHAINS } from "@/shared/payment-config";

/**
 * `key in PAYMENT_CHAINS` is not a membership test — it walks the prototype
 * chain. The first version of the chain validation used it, so every
 * Object.prototype key passed, and PAYMENT_CHAINS["constructor"] is a
 * function: .isSolana is undefined, and the request proceeded down the EVM
 * path with a chain that does not exist. It did not even fail loudly.
 */
describe("isChainKey", () => {
  it("accepts every chain that is actually configured", () => {
    for (const k of Object.keys(PAYMENT_CHAINS)) expect(isChainKey(k)).toBe(true);
  });

  it("refuses inherited Object.prototype keys", () => {
    for (const k of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
      expect(isChainKey(k), `${k} must not pass as a chain`).toBe(false);
      // and the reason the old check let them through:
      expect(k in PAYMENT_CHAINS || k === "__proto__").toBe(true);
    }
  });

  it("refuses an empty string, so it can be treated as absent", () => {
    expect(isChainKey("")).toBe(false);
  });

  it("refuses non-strings rather than coercing them", () => {
    for (const v of [null, undefined, 0, {}, [], true]) expect(isChainKey(v)).toBe(false);
  });
});
