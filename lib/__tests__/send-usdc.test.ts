import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";

/**
 * The Send USDC form parses money from digits, never through a float. The
 * comma case is the one that bit the other product: "1,5" read as 1 or as NaN
 * sends the wrong amount or nothing. Every branch here was proven able to
 * fail by breaking the helper and watching the run go red (2026-09-24).
 */
import {
  base64ToBytes,
  explorerTxUrl,
  formatMicro,
  isSolanaAddress,
  parseUsdcAmount,
  signingErrorMessage,
  withdrawErrorMessage,
} from "@/lib/send-usdc";

describe("parseUsdcAmount", () => {
  it("reads comma and dot decimals to the same integer micro amount", () => {
    expect(parseUsdcAmount("1,5")).toBe(1_500_000);
    expect(parseUsdcAmount("1.5")).toBe(1_500_000);
    expect(parseUsdcAmount(" 12 ")).toBe(12_000_000);
    expect(parseUsdcAmount(".5")).toBe(500_000);
    expect(parseUsdcAmount("0.000001")).toBe(1);
  });

  it("never rounds: a value a float would mangle comes out exact", () => {
    // 0.1 + 0.2 territory: digits in, digits out.
    expect(parseUsdcAmount("0.3")).toBe(300_000);
    expect(parseUsdcAmount("1234567.654321")).toBe(1_234_567_654_321);
  });

  it("refuses zero, more than six decimals, and anything that is not a number", () => {
    expect(parseUsdcAmount("0")).toBeNull();
    expect(parseUsdcAmount("0,0")).toBeNull();
    expect(parseUsdcAmount("1.1234567")).toBeNull();
    expect(parseUsdcAmount("1,000.50")).toBeNull();
    expect(parseUsdcAmount("-1")).toBeNull();
    expect(parseUsdcAmount("1e3")).toBeNull();
    expect(parseUsdcAmount("abc")).toBeNull();
    expect(parseUsdcAmount("")).toBeNull();
    expect(parseUsdcAmount("1.")).toBeNull();
  });
});

describe("formatMicro", () => {
  it("shows two decimals, more only when they carry value", () => {
    expect(formatMicro(1_500_000)).toBe("1.50");
    expect(formatMicro(1_000_000)).toBe("1.00");
    expect(formatMicro(1_234_567)).toBe("1.234567");
    expect(formatMicro(1)).toBe("0.000001");
    expect(formatMicro(50_000)).toBe("0.05");
  });
});

describe("isSolanaAddress", () => {
  it("accepts a wallet key and refuses garbage, an off-curve PDA and an EVM address", () => {
    expect(isSolanaAddress("11111111111111111111111111111111")).toBe(true);
    expect(isSolanaAddress(" 11111111111111111111111111111111 ")).toBe(true);
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("seed")], new PublicKey("11111111111111111111111111111111"));
    expect(isSolanaAddress(pda.toBase58())).toBe(false);
    expect(isSolanaAddress("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(isSolanaAddress("not an address")).toBe(false);
    expect(isSolanaAddress("")).toBe(false);
  });
});

describe("explorerTxUrl", () => {
  it("keeps the devnet cluster parameter and points at the transaction", () => {
    expect(explorerTxUrl("solana-devnet", "abc")).toBe("https://explorer.solana.com/tx/abc?cluster=devnet");
    expect(explorerTxUrl("solana", "abc")).toBe("https://explorer.solana.com/tx/abc");
  });

  it("gives no link for a chain it does not know rather than a wrong one", () => {
    expect(explorerTxUrl(undefined, "abc")).toBeNull();
    expect(explorerTxUrl("base", "abc")).toBeNull();
    expect(explorerTxUrl("constructor", "abc")).toBeNull();
  });
});

describe("withdrawErrorMessage", () => {
  const fb = "fallback";
  it("maps each server code to its own sentence", () => {
    expect(withdrawErrorMessage({ status: 400, body: { code: "INSUFFICIENT_FUNDS", error: "x" } }, fb)).toMatch(/does not hold/);
    expect(withdrawErrorMessage({ status: 429, body: { code: "RATE_LIMITED", error: "x" } }, fb)).toMatch(/hourly limit/);
    expect(withdrawErrorMessage({ status: 409, body: { code: "EXPIRED", error: "x" } }, fb)).toMatch(/took too long, start again/);
    expect(withdrawErrorMessage({ status: 400, body: { code: "NO_RECIPIENT_ACCOUNT", error: "x" } }, fb)).toMatch(/never held USDC/);
    expect(withdrawErrorMessage({ status: 400, body: { code: "FROM_MISMATCH", error: "x" } }, fb)).toMatch(/reload/);
    expect(withdrawErrorMessage({ status: 401, body: { error: "Not signed in" } }, fb)).toMatch(/sign in again/);
  });

  it("shows the not-migrated sentence verbatim", () => {
    expect(
      withdrawErrorMessage({ status: 503, body: { code: "WITHDRAWALS_NOT_MIGRATED", error: "withdrawals table not migrated" } }, fb),
    ).toBe("withdrawals table not migrated");
  });

  it("uses the route's own sentence when there is one, the fallback when the body is not ours", () => {
    expect(withdrawErrorMessage({ status: 400, body: { error: "Recipient is your own wallet" } }, fb)).toBe("Recipient is your own wallet");
    expect(withdrawErrorMessage({ status: 502, body: null }, fb)).toBe(fb);
    expect(withdrawErrorMessage({ status: 500, body: { error: { stack: "at foo" } } }, fb)).toBe(fb);
  });
});

describe("signingErrorMessage", () => {
  it("tells a cancellation apart from a wallet failure, both say nothing moved", () => {
    expect(signingErrorMessage(new Error("User rejected the request"))).toMatch(/cancelled, nothing moved/);
    expect(signingErrorMessage(new Error("boom"))).toMatch(/could not sign, nothing moved/);
    expect(signingErrorMessage("boom")).toMatch(/could not sign, nothing moved/);
  });
});

describe("base64ToBytes", () => {
  it("decodes to the exact bytes", () => {
    expect(Array.from(base64ToBytes("AAEC/w=="))).toEqual([0, 1, 2, 255]);
  });
});
