import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

/**
 * ENG-12. Payments used exactly one RPC URL: an outage at that provider
 * stopped every payment and every balance. The connection now moves to the
 * next endpoint when one cannot answer, and never when one answered no.
 */

const notifyAdmins = vi.fn(async () => {});
vi.mock("@/lib/admin-notify", () => ({ notifyAdmins }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClientSafe: () => ({}) }));

import { solanaConnection, solanaRpcUrls } from "@/lib/payments/solana";
import { submitAndConfirm } from "@/lib/payments/x402-settle";
import { getUsdcBalance } from "@/lib/usdc-balance";

const PRIMARY = "https://primary.example/?api-key=KEY-THAT-MUST-NOT-BE-LOGGED";
const SECOND = "https://second.example/";
type Mode = "down" | "500" | "hang" | "reject" | "ok";

let primary: Mode = "ok";
const hits: { host: string; method: string; signal: boolean }[] = [];

function answer(method: string, id: unknown) {
  const result =
    method === "sendTransaction" ? "5".repeat(64)
    : method === "getSignatureStatuses" ? { context: { slot: 1 }, value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" }] }
    : method === "getTokenAccountBalance" ? { context: { slot: 1 }, value: { amount: "5000000", decimals: 6, uiAmount: 5, uiAmountString: "5" } }
    : null;
  return Response.json({ jsonrpc: "2.0", id, result });
}

beforeEach(() => {
  primary = "ok";
  hits.length = 0;
  notifyAdmins.mockClear();
  vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana");
  vi.stubEnv("SOLANA_RPC_URL", PRIMARY);
  vi.stubEnv("SOLANA_RPC_URL_FALLBACK", SECOND);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const { method, id } = JSON.parse(String(init.body));
    const host = new URL(url).host;
    hits.push({ host, method, signal: Boolean(init.signal) });
    if (host === "primary.example") {
      if (primary === "down") throw new TypeError("fetch failed");
      if (primary === "500") return new Response("upstream", { status: 503 });
      if (primary === "hang") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (primary === "reject") {
        return Response.json({ jsonrpc: "2.0", id, error: { code: -32002, message: "Transaction simulation failed: insufficient funds" } });
      }
    }
    return answer(method, id);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function signedTx(): VersionedTransaction {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return tx;
}

describe("the endpoints", () => {
  it("are ours, then the second provider, then the chain's public one, on mainnet", () => {
    expect(solanaRpcUrls()).toEqual([PRIMARY, SECOND, "https://api.mainnet-beta.solana.com"]);
  });

  it("ignore both mainnet URLs on devnet", () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
    expect(solanaRpcUrls()).toEqual(["https://api.devnet.solana.com"]);
  });
});

describe("a payment", () => {
  it("settles through the second provider while the first is unreachable", async () => {
    primary = "down";
    expect(await submitAndConfirm(solanaConnection(), signedTx())).toEqual({ ok: true });
    expect(hits.filter((h) => h.method === "sendTransaction").map((h) => h.host)).toEqual(["primary.example", "second.example"]);
  });

  it("moves on from a 5xx and from an endpoint that hangs", async () => {
    for (const mode of ["500", "hang"] as const) {
      primary = mode;
      hits.length = 0;
      expect(await submitAndConfirm(solanaConnection(), signedTx())).toEqual({ ok: true });
      expect(hits.some((h) => h.host === "second.example")).toBe(true);
    }
    // Every attempt that may be given up on carries its own timeout.
    expect(hits.filter((h) => h.host === "primary.example").every((h) => h.signal)).toBe(true);
  });

  it("is never re-sent elsewhere when the first endpoint rejected it", async () => {
    primary = "reject";
    const res = await submitAndConfirm(solanaConnection(), signedTx());
    expect(res.ok).toBe(false);
    expect(hits.map((h) => h.host)).toEqual(["primary.example"]);
  });
});

describe("the balance and the alert", () => {
  it("reads a balance through the same failover", async () => {
    primary = "down";
    expect(await getUsdcBalance(Keypair.generate().publicKey.toBase58())).toBe(5);
  });

  it("logs the host, never the URL with its key", async () => {
    primary = "down";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await getUsdcBalance(Keypair.generate().publicKey.toBase58());
    const logged = errors.mock.calls.flat().join(" ");
    errors.mockRestore();
    expect(logged).toMatch(/primary\.example/);
    expect(logged).not.toMatch(/KEY-THAT-MUST-NOT-BE-LOGGED|api-key/);
  });

  it("mails the admins once per instance, not once per request, without the key", async () => {
    vi.resetModules(); // a fresh instance: nothing reported yet
    const fresh = await import("@/lib/usdc-balance");
    primary = "down";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) await fresh.getUsdcBalance(Keypair.generate().publicKey.toBase58());
    await vi.waitFor(() => expect(notifyAdmins).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    errors.mockRestore();
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    const mail = JSON.stringify(notifyAdmins.mock.calls[0]);
    expect(mail).toMatch(/primary\.example/);
    expect(mail).not.toMatch(/KEY-THAT-MUST-NOT-BE-LOGGED/);
  });
});
