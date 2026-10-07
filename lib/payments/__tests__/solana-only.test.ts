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
 *
 * Superseded for the generate route on 2026-10-02 (Kev: "den alten weg
 * raushauen"): it takes intents only, and its x402 code, EVM included, is
 * deleted rather than switched off.
 */

const ROOT = join(__dirname, "..", "..", "..");
const GENERATE = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
const CONTENT = readSource(join(ROOT, "app", "api", "prompts", "[id]", "content", "route.ts"));

describe("no route settles on a non-Solana chain", () => {
  it("the generate route settles nothing itself: it takes intents only", () => {
    expect(GENERATE).toMatch(/if \(!intentId\) \{/);
    expect(GENERATE).not.toMatch(/headers\.get\(["']X-PAYMENT["']\)/i);
    expect(GENERATE).not.toMatch(/paymentEngine|solana-x402-verifier/);
  });

  it("the twin route refuses it too — a switch with a hole is not a switch", () => {
    expect(CONTENT).toMatch(/!isSolanaChain\(chain\)/);
    expect(CONTENT).toMatch(/solanaOnly: true/);
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

  it("the generate route's EVM code is deleted, not switched off", () => {
    // Kev, 2026-10-02, superseding 2026-08-19 for this route.
    expect(GENERATE).not.toMatch(/useUpto|settleWithUpto|SERVER_WALLET_ADDRESS/);
  });
});
