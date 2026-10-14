import { describe, it, expect } from "vitest";
import { chipLabel, overBalance, balanceView } from "../price";
import type { GenerationQuote } from "@/lib/generation-checkout";

const quote = (totalMicro: number, totalUsd: string): GenerationQuote => ({
  totalMicro,
  totalUsd,
  networkFeeUsd: "0.00",
  artistUsd: "0.00",
  expiresAt: "2026-10-09T12:05:00Z",
  appliedRule: null,
});
const q534 = quote(534_000, "0.534");

describe("chipLabel", () => {
  const base = { signedIn: true, free: false, quote: null, pending: false };
  it("shows $0.00 on the free host, never the word free", () => {
    expect(chipLabel({ ...base, free: true })).toBe("$0.00");
  });

  it("shows the server's total", () => {
    expect(chipLabel({ ...base, quote: q534 })).toBe("$0.534");
  });

  it("shows … while the price is being asked", () => {
    expect(chipLabel({ ...base, pending: true })).toBe("…");
  });

  it("shows nothing without a price, or when signed out", () => {
    expect(chipLabel(base)).toBeNull();
    expect(chipLabel({ ...base, signedIn: false, free: true })).toBeNull();
    expect(chipLabel({ ...base, signedIn: false, quote: q534 })).toBeNull();
  });
});

describe("overBalance", () => {
  it("compares in micro units: float dust in the balance never makes it short", () => {
    expect(overBalance(0.1 + 0.2, 300_000)).toBe(false);
    expect(overBalance(0.7 - 0.4, 300_000)).toBe(false);
  });

  it("is short by a single micro-dollar, and not at exactly the price", () => {
    expect(overBalance(0.3, 300_001)).toBe(true);
    expect(overBalance(0.3, 300_000)).toBe(false);
  });
});

describe("balanceView", () => {
  const base = { payer: "So1anaPayer111", ready: true, balance: 4.2, free: false, quote: q534 };
  it("shows the balance, red when the render costs more", () => {
    expect(balanceView(base)).toEqual({ text: "$4.20", short: false });
    expect(balanceView({ ...base, balance: 0.12 })).toEqual({ text: "$0.12", short: true });
    expect(balanceView({ ...base, balance: 0.12, quote: null })).toEqual({ text: "$0.12", short: false });
  });

  it("shows … until the balance is read", () => {
    expect(balanceView({ ...base, ready: false, balance: 0 })).toEqual({ text: "…", short: false });
  });

  it("is hidden without a payer, for an EVM address, and on the free host", () => {
    expect(balanceView({ ...base, payer: null })).toBeNull();
    expect(balanceView({ ...base, payer: "0xabc" })).toBeNull();
    expect(balanceView({ ...base, free: true })).toBeNull();
  });
});
