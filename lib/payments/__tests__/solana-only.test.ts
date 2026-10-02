import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { PAYMENT_CHAINS, isSolanaChain, type ChainKey } from "@/shared/payment-config";

/**
 * Enki settles on Solana, and only on Solana (Kev, 2026-08-19).
 *
 * The EVM half of the payment code is real and was reachable —
 * useX402PaymentProduction was mounted in four components and defaulted to
 * base-sepolia — so leaving it merely unused is not the same as switching it
 * off. The decision belongs where the money is, not only in the UI.
 */

const ROOT = join(__dirname, "..", "..", "..");
const GENERATE = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
const CONTENT = readSource(join(ROOT, "app", "api", "prompts", "[id]", "content", "route.ts"));

describe("no route settles on a non-Solana chain", () => {
  it("the generate route refuses an EVM settlement", () => {
    expect(GENERATE).toMatch(/!intentId && !isSolanaPayment/);
    expect(GENERATE).toMatch(/solanaOnly: true/);
  });

  it("the twin route refuses it too — a switch with a hole is not a switch", () => {
    expect(CONTENT).toMatch(/!isSolanaChain\(chain\)/);
    expect(CONTENT).toMatch(/solanaOnly: true/);
  });

  it("refuses BEFORE the x402 branch does any pricing or settling", () => {
    const guard = GENERATE.indexOf("!intentId && !isSolanaPayment");
    const branch = GENERATE.indexOf("X402 Payment Request");
    expect(guard).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(guard);
  });

  it("still lets the Solana rails through — this is a switch, not a wall", () => {
    // Both the intent path and Solana x402 must remain open.
    for (const k of Object.keys(PAYMENT_CHAINS) as ChainKey[]) {
      if (isSolanaChain(k)) expect(k).toMatch(/solana/);
    }
    expect(isSolanaChain("solana")).toBe(true);
    expect(isSolanaChain("solana-devnet")).toBe(true);
    expect(isSolanaChain("base-sepolia")).toBe(false);
  });

  it("the EVM code is switched off, not deleted", () => {
    // Kev: "das soll als code existieren, aber nicht implementiert sein".
    expect(GENERATE).toMatch(/X402 Payment Request/);
    expect(GENERATE).toMatch(/useUpto/);
  });
});
