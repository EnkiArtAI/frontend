import { describe, it, expect } from "vitest";
import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { paymentLanded, simulatePayment } from "@/lib/payments/x402-settle";

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

describe("a payment that already landed", () => {
  const history = (status: { err: unknown } | null, opts: { fail?: boolean } = {}) => ({
    getSignatureStatuses: async (_s: string[], o: { searchTransactionHistory?: boolean }) => {
      if (opts.fail) throw new Error("node down");
      if (!o?.searchTransactionHistory) return { value: [null] };
      return { value: [status] };
    },
  }) as unknown as Connection;

  it("is found in the signature history once its blockhash is gone", async () => {
    expect(await paymentLanded(history({ err: null }), "sig")).toBe(true);
  });

  it("is not a landing when it failed on chain, or is unknown", async () => {
    expect(await paymentLanded(history({ err: { InstructionError: [0, "x"] } }), "sig")).toBe(false);
    expect(await paymentLanded(history(null), "sig")).toBe(false);
    expect(await paymentLanded(history(null, { fail: true }), "sig")).toBe(false);
  });
});
