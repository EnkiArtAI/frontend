import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * ENG-12. Payments used exactly one RPC URL: an outage at that provider
 * stopped every payment and every balance. The connection now moves to the
 * next endpoint when one cannot answer, never when one answered no, and the
 * payment paths confirm over HTTP, because web3.js's own confirmation listens
 * on the FIRST endpoint's websocket, which is down exactly then.
 */

const notifyAdmins = vi.fn(async () => {});
vi.mock("@/lib/admin-notify", () => ({ notifyAdmins }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClientSafe: () => ({}) }));

import { confirmSignature, resetRpcHealth, solanaConnection, solanaRpcUrls } from "@/lib/payments/solana";
import { submitAndConfirm } from "@/lib/payments/x402-settle";
import { getUsdcBalance } from "@/lib/usdc-balance";

const PRIMARY = "https://primary.example/?api-key=KEY-THAT-MUST-NOT-BE-LOGGED";
const SECOND = "https://second.example/";
type Mode = "ok" | "down" | "500" | "401" | "403" | "429" | "hang" | "reject" | "forwarded" | "forwarded-lagging" | "status-down";

let primary: Mode = "ok";
let blockHeight = 10;
let landed = true;
let onChainErr: unknown = null;
const hits: { host: string; method: string; params: unknown[] }[] = [];
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

function answer(method: string, id: unknown) {
  const ctx = { context: { slot: 1 } };
  const result =
    method === "sendTransaction" ? "5".repeat(64)
    : method === "getSignatureStatuses" ? { ...ctx, value: [landed ? { slot: 1, confirmations: null, err: onChainErr, confirmationStatus: "confirmed" } : null] }
    : method === "getTokenAccountBalance" ? { ...ctx, value: { amount: "5000000", decimals: 6, uiAmount: 5, uiAmountString: "5" } }
    : method === "getLatestBlockhash" ? { ...ctx, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }
    : method === "getBlockHeight" ? blockHeight
    : null;
  return Response.json({ jsonrpc: "2.0", id, result });
}

const rpcError = (id: unknown, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code: -32002, message } });

beforeEach(() => {
  primary = "ok";
  blockHeight = 10;
  landed = true;
  onChainErr = null;
  hits.length = 0;
  resetRpcHealth();
  notifyAdmins.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana");
  vi.stubEnv("SOLANA_RPC_URL", PRIMARY);
  vi.stubEnv("SOLANA_RPC_URL_FALLBACK", SECOND);
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const { method, id, params } = JSON.parse(String(init.body));
    const host = new URL(url).host;
    hits.push({ host, method, params });
    if (primary === "status-down" && method === "getSignatureStatuses") return Promise.reject(new TypeError("fetch failed"));
    if (host === "primary.example") {
      if (primary === "down") return Promise.reject(new TypeError("fetch failed"));
      if (["500", "401", "403", "429"].includes(primary)) return Promise.resolve(new Response("refused", { status: Number(primary) }));
      if (primary === "hang" || (primary.startsWith("forwarded") && method === "sendTransaction")) {
        // Hangs until the failover gives up on it; "forwarded" has passed the transaction on first.
        return new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      if (primary === "reject" && method === "sendTransaction") return Promise.resolve(rpcError(id, "Transaction simulation failed: insufficient funds"));
    }
    if (host === "second.example" && primary === "forwarded" && method === "sendTransaction") {
      return Promise.resolve(rpcError(id, "Transaction simulation failed: This transaction has already been processed"));
    }
    if (host === "second.example" && primary === "forwarded-lagging" && method === "sendTransaction") {
      return Promise.resolve(rpcError(id, "Transaction simulation failed: Blockhash not found"));
    }
    return Promise.resolve(answer(method, id));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function signedTx(): VersionedTransaction {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return tx;
}

const sentTo = () => hits.filter((h) => h.method === "sendTransaction").map((h) => h.host);

describe("the endpoints", () => {
  it("are ours, then the second provider, then the chain's public one, on mainnet", () => {
    expect(solanaRpcUrls()).toEqual([PRIMARY, SECOND, "https://api.mainnet-beta.solana.com"]);
  });

  it("ignore both mainnet URLs on devnet", () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
    expect(solanaRpcUrls()).toEqual(["https://api.devnet.solana.com"]);
  });

  it("skip a URL that cannot be parsed, without logging it", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("SOLANA_RPC_URL_FALLBACK", "second.example/?api-key=ANOTHER-KEY");
    expect(solanaRpcUrls()).toEqual([PRIMARY, "https://api.mainnet-beta.solana.com"]);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/ANOTHER-KEY/);
  });
});

describe("a payment", () => {
  it("settles through the second provider while the first is unreachable", async () => {
    primary = "down";
    expect(await submitAndConfirm(solanaConnection(), signedTx())).toMatchObject({ ok: true });
    expect(sentTo()).toEqual(["primary.example", "second.example"]);
  });

  it("moves on from a 5xx, a refused key and a spent quota", async () => {
    for (const mode of ["500", "401", "403", "429"] as const) {
      primary = mode;
      hits.length = 0;
      resetRpcHealth();
      expect(await submitAndConfirm(solanaConnection(), signedTx()), mode).toMatchObject({ ok: true });
      expect(sentTo(), mode).toEqual(["primary.example", "second.example"]);
    }
  });

  it("gives a hanging endpoint 10 s, then moves on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    primary = "hang";
    const balance = getUsdcBalance(Keypair.generate().publicKey.toBase58());
    await vi.advanceTimersByTimeAsync(9_000);
    expect(hits.some((h) => h.host === "second.example")).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await balance).toBe(5);
  });

  it("is never re-sent elsewhere when the first endpoint rejected it, and the rejection is final", async () => {
    primary = "reject";
    landed = false;
    const started = Date.now();
    const res = await submitAndConfirm(solanaConnection(), signedTx());
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/insufficient funds/), pending: false });
    expect(sentTo()).toEqual(["primary.example"]);
    expect(hits.filter((h) => h.method === "getSignatureStatuses")).toHaveLength(1); // one look, no waiting
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports a payment that failed on chain as refused, not pending", async () => {
    onChainErr = { InstructionError: [0, { Custom: 1 }] };
    expect(await submitAndConfirm(solanaConnection(), signedTx())).toMatchObject({ ok: false, error: expect.stringMatching(/failed on-chain/), pending: false });
  });

  it("counts as settled when a lagging node refuses what the first endpoint forwarded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    primary = "forwarded-lagging";
    const settled = submitAndConfirm(solanaConnection(), signedTx());
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await settled).toMatchObject({ ok: true });
  });

  it("leaves the payment pending, not refused, when no endpoint can answer the confirmation", async () => {
    primary = "status-down";
    const res = await submitAndConfirm(solanaConnection(), signedTx());
    expect(res).toMatchObject({ ok: false, pending: true });
  });

  it("counts as settled when the first endpoint forwarded it and the second says already processed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    primary = "forwarded";
    const settled = submitAndConfirm(solanaConnection(), signedTx());
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await settled).toMatchObject({ ok: true });
  });

  it("reports a send that never landed as a timeout, the case the agent route keeps the signature for", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    primary = "down";
    landed = false;
    const settled = submitAndConfirm(solanaConnection(), signedTx(), 5_000);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await settled).toMatchObject({ ok: false, error: "Timed out waiting for confirmation", pending: true });
  });
});

describe("HTTP payment confirmation", () => {
  it("the direct-transfer agent rail retains three node retries", async () => {
    await submitAndConfirm(solanaConnection(), signedTx());
    const sent = hits.find(hit => hit.method === "sendTransaction");
    expect((sent?.params[1] as { maxRetries?: number }).maxRetries).toBe(3);
  });

  it("an expired blockhash ends the wait instead of hanging", async () => {
    landed = false;
    blockHeight = 101;
    await expect(confirmSignature(solanaConnection(), "5".repeat(64), { lastValidBlockHeight: 100 })).rejects.toThrow(/expired/);
  });

  it("no payment path waits on a websocket confirmation", () => {
    const ROOT = join(__dirname, "..", "..");
    for (const f of [["lib", "payments", "escrow", "server-chain.ts"], ["lib", "payments", "x402-settle.ts"], ["app", "api", "x402", "generate", "route.ts"]]) {
      expect(readSource(join(ROOT, ...f)), f.join("/")).not.toMatch(/sendAndConfirmTransaction|confirmTransaction\(/);
    }
  });
});

describe("an endpoint that did not answer", () => {
  it("is skipped for 30 s on this instance, so only the first call pays for it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    primary = "down";
    const addr = Keypair.generate().publicKey.toBase58();
    await getUsdcBalance(addr);
    expect(hits.map((h) => h.host)).toEqual(["primary.example", "second.example"]);
    hits.length = 0;
    await getUsdcBalance(addr);
    expect(hits.map((h) => h.host)).toEqual(["second.example"]);
    hits.length = 0;
    vi.setSystemTime(Date.now() + 31_000);
    await getUsdcBalance(addr);
    expect(hits[0].host).toBe("primary.example");
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
    expect(logged).toMatch(/primary\.example/);
    expect(logged).not.toMatch(/KEY-THAT-MUST-NOT-BE-LOGGED|api-key/);
  });

  it("mails the admins once per instance, not once per request, without the key", async () => {
    vi.resetModules(); // a fresh instance: nothing reported yet
    const fresh = await import("@/lib/usdc-balance");
    primary = "down";
    for (let i = 0; i < 3; i++) await fresh.getUsdcBalance(Keypair.generate().publicKey.toBase58());
    await vi.waitFor(() => expect(notifyAdmins).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    const mail = JSON.stringify(notifyAdmins.mock.calls[0]);
    expect(mail).toMatch(/primary\.example/);
    expect(mail).not.toMatch(/KEY-THAT-MUST-NOT-BE-LOGGED/);
  });
});
