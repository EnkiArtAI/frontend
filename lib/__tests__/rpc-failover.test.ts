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

import { confirmSignature, solanaConnection, solanaRpcUrls } from "@/lib/payments/solana";
import { submitAndConfirm } from "@/lib/payments/x402-settle";
import { closeNonceAccount, createNonceAccount } from "@/lib/payments/nonce";
import { getUsdcBalance } from "@/lib/usdc-balance";

const PRIMARY = "https://primary.example/?api-key=KEY-THAT-MUST-NOT-BE-LOGGED";
const SECOND = "https://second.example/";
type Mode = "ok" | "down" | "500" | "401" | "403" | "429" | "hang" | "reject" | "forwarded";

let primary: Mode = "ok";
let blockHeight = 10;
let landed = true;
const hits: { host: string; method: string }[] = [];
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const AUTHORITY = Keypair.generate().publicKey;

/** An initialised nonce account, laid out as NonceAccount.fromAccountData reads it. */
function nonceAccountData(): string {
  const b = Buffer.alloc(80);
  b.writeUInt32LE(1, 4); // initialised
  AUTHORITY.toBuffer().copy(b, 8);
  Keypair.generate().publicKey.toBuffer().copy(b, 40); // the nonce
  return b.toString("base64");
}

function answer(method: string, id: unknown) {
  const ctx = { context: { slot: 1 } };
  const result =
    method === "sendTransaction" ? "5".repeat(64)
    : method === "getSignatureStatuses" ? { ...ctx, value: [landed ? { slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" } : null] }
    : method === "getTokenAccountBalance" ? { ...ctx, value: { amount: "5000000", decimals: 6, uiAmount: 5, uiAmountString: "5" } }
    : method === "getLatestBlockhash" ? { ...ctx, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }
    : method === "getBlockHeight" ? blockHeight
    : method === "getMinimumBalanceForRentExemption" ? 1_447_680
    : method === "getAccountInfo" ? { ...ctx, value: { data: [nonceAccountData(), "base64"], executable: false, lamports: 1_447_680, owner: "11111111111111111111111111111111", rentEpoch: 0, space: 80 } }
    : null;
  return Response.json({ jsonrpc: "2.0", id, result });
}

const rpcError = (id: unknown, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code: -32002, message } });

beforeEach(() => {
  primary = "ok";
  blockHeight = 10;
  landed = true;
  hits.length = 0;
  notifyAdmins.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana");
  vi.stubEnv("SOLANA_RPC_URL", PRIMARY);
  vi.stubEnv("SOLANA_RPC_URL_FALLBACK", SECOND);
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const { method, id } = JSON.parse(String(init.body));
    const host = new URL(url).host;
    hits.push({ host, method });
    if (host === "primary.example") {
      if (primary === "down") return Promise.reject(new TypeError("fetch failed"));
      if (["500", "401", "403", "429"].includes(primary)) return Promise.resolve(new Response("refused", { status: Number(primary) }));
      if (primary === "hang" || (primary === "forwarded" && method === "sendTransaction")) {
        // Hangs until the failover gives up on it; "forwarded" has passed the transaction on first.
        return new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      if (primary === "reject") return Promise.resolve(rpcError(id, "Transaction simulation failed: insufficient funds"));
    }
    if (host === "second.example" && primary === "forwarded" && method === "sendTransaction") {
      return Promise.resolve(rpcError(id, "Transaction simulation failed: This transaction has already been processed"));
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
    expect(await submitAndConfirm(solanaConnection(), signedTx())).toEqual({ ok: true });
    expect(sentTo()).toEqual(["primary.example", "second.example"]);
  });

  it("moves on from a 5xx, a refused key and a spent quota", async () => {
    for (const mode of ["500", "401", "403", "429"] as const) {
      primary = mode;
      hits.length = 0;
      expect(await submitAndConfirm(solanaConnection(), signedTx()), mode).toEqual({ ok: true });
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

  it("is never re-sent elsewhere when the first endpoint rejected it", async () => {
    primary = "reject";
    const res = await submitAndConfirm(solanaConnection(), signedTx());
    expect(res.ok).toBe(false);
    expect(hits.map((h) => h.host)).toEqual(["primary.example"]);
  });

  it("counts as settled when the first endpoint forwarded it and the second says already processed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    primary = "forwarded";
    const settled = submitAndConfirm(solanaConnection(), signedTx());
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await settled).toEqual({ ok: true });
  });

  it("reports a send that never landed as a timeout, the case the agent route keeps the signature for", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    primary = "down";
    landed = false;
    const settled = submitAndConfirm(solanaConnection(), signedTx(), 5_000);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await settled).toEqual({ ok: false, error: "Timed out waiting for confirmation" });
  });
});

describe("the nonce accounts of the human rail", () => {
  it("are created and closed with the first endpoint down: confirmed over HTTP, no websocket", async () => {
    primary = "down";
    const created = await createNonceAccount(solanaConnection(), Keypair.generate());
    expect(created.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(await closeNonceAccount(solanaConnection(), created.address, Keypair.generate())).toBe("closed");
    expect(sentTo().filter((h) => h === "second.example")).toHaveLength(2);
  });

  it("an expired blockhash ends the wait instead of hanging", async () => {
    landed = false;
    blockHeight = 101;
    await expect(confirmSignature(solanaConnection(), "5".repeat(64), { lastValidBlockHeight: 100 })).rejects.toThrow(/expired/);
  });

  it("no payment path waits on a websocket confirmation", () => {
    const ROOT = join(__dirname, "..", "..");
    for (const f of [["lib", "payments", "nonce.ts"], ["lib", "payments", "x402-settle.ts"], ["app", "api", "x402", "generate", "route.ts"]]) {
      expect(readSource(join(ROOT, ...f)), f.join("/")).not.toMatch(/sendAndConfirmTransaction|confirmTransaction\(/);
    }
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
