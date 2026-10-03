import { describe, it, expect } from "vitest";
import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { simulatePayment } from "@/lib/payments/x402-settle";

/** An unpayable payment is refused before anything about the request is decided (round-3 review). */
const conn = (result: { err: unknown } | Error) => ({
  simulateTransaction: async (_tx: unknown, opts: { sigVerify?: boolean }) => {
    if (!opts?.sigVerify) throw new Error("signatures were not checked");
    if (result instanceof Error) throw result;
    return { value: result };
  },
}) as unknown as Connection;
const tx = {} as VersionedTransaction;

describe("simulating an agent's payment", () => {
  it("passes a payment that would settle, with its signatures checked", async () => {
    expect(await simulatePayment(conn({ err: null }), tx)).toEqual({ ok: true });
  });

  it("refuses a forged signature or an empty payer", async () => {
    expect(await simulatePayment(conn({ err: "SignatureFailure" }), tx)).toEqual({ ok: false, error: 'Transaction simulation failed: "SignatureFailure"' });
  });

  it("refuses when the node cannot simulate", async () => {
    expect((await simulatePayment(conn(new Error("node down")), tx)).ok).toBe(false);
  });
});
