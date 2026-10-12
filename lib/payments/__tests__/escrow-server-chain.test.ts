import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { address } from "@solana/kit";
import { feePayerKeypair, solanaRpcUrls } from "../solana";
import { escrowClock, escrowServerChain, ESCROW_CLOCK_ADDRESS } from "../escrow/server-chain";
import type { EscrowChainAccount } from "../escrow/confirmation";
vi.mock("../solana", () => ({ feePayerKeypair: vi.fn(), solanaRpcUrls: vi.fn() }));
const PROGRAM = "hNNT7mTmthTVvnw4NYo6jYoBTDazRgweWTBHBmwgcak";
const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const clockBytes = () => {
  const bytes = Buffer.alloc(40); bytes.writeBigUInt64LE(BigInt(500), 0); bytes.writeBigInt64LE(BigInt(1000), 32); return bytes;
};
const clockAccount = (): EscrowChainAccount => ({ address: ESCROW_CLOCK_ADDRESS,
  programAddress: address("Sysvar1111111111111111111111111111111111111"), executable: false, data: clockBytes() });
let requests: Array<{ method: string; params: unknown[] }>;
let handler: (request: { method: string; params: unknown[] }) => unknown;
beforeEach(() => {
  vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet"); vi.stubEnv("SOLANA_ESCROW_PROGRAM_ID", PROGRAM);
  vi.mocked(feePayerKeypair).mockReturnValue(Keypair.fromSeed(new Uint8Array(32).fill(2)));
  vi.mocked(solanaRpcUrls).mockReturnValue(["https://rpc-test.invalid/private-credential"]);
  requests = [];
  handler = request => {
    if (request.method === "getGenesisHash") return genesis;
    if (request.method === "getMultipleAccounts") return { context: { slot: 500 }, value: [null, {
      owner: clockAccount().programAddress, executable: false, lamports: 1, rentEpoch: 0,
      data: [clockBytes().toString("base64"), "base64"], space: 40,
    }] };
    if (request.method === "getBlock") return { blockHeight: 2000 };
    throw new Error(`Unexpected test RPC ${request.method}`);
  };
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string) as { id: number; method: string; params: unknown[] };
    requests.push(request);
    return Response.json({ jsonrpc: "2.0", id: request.id, result: handler(request) });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Escrow Kit RPC adapter", () => {
  it("requires an explicitly configured network and program", () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", ""); vi.stubEnv("SOLANA_FUND_CHAIN", "");
    expect(() => escrowServerChain()).toThrow("network is not configured");
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet"); vi.stubEnv("SOLANA_ESCROW_PROGRAM_ID", "");
    expect(() => escrowServerChain()).toThrow("program is not configured");
  });
  it("reads accounts and Clock in one bank with the requested commitment and minimum slot", async () => {
    const bank = await escrowServerChain().accounts([address(PROGRAM)], "confirmed", BigInt(450));
    expect(bank).toMatchObject({ slot: BigInt(500), chainNowSeconds: 1000, accounts: [null] });
    expect(requests).toEqual([
      expect.objectContaining({ method: "getGenesisHash" }),
      expect.objectContaining({ method: "getMultipleAccounts", params: [[PROGRAM, ESCROW_CLOCK_ADDRESS], {
        commitment: "confirmed", encoding: "base64", minContextSlot: 450,
      }] }),
    ]);
  });
  it("refuses a provider connected to a different cluster", async () => {
    handler = () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    await expect(escrowServerChain().accounts([address(PROGRAM)], "confirmed")).rejects.toThrow("temporarily unavailable");
    expect(requests.map(r => r.method)).toEqual(["getGenesisHash"]);
  });
  it("uses the exact finalized snapshot slot to prove blockheight", async () => {
    const chain = escrowServerChain();
    expect(await chain.finalizedHeight(BigInt(500))).toBe(BigInt(2000));
    expect(requests.at(-1)).toMatchObject({ method: "getBlock", params: [500, {
      transactionDetails: "none", rewards: false,
    }] });
    // Kit omits finalized because it is the wire-level RPC default.
    expect((requests.at(-1)?.params[1] as { commitment?: string }).commitment ?? "finalized").toBe("finalized");
  });
  it("does not expose RPC URLs or credentials in network errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private-credential https://rpc-test.invalid"); }));
    await expect(escrowServerChain().accounts([address(PROGRAM)], "confirmed"))
      .rejects.toMatchObject({ message: "The payment network is temporarily unavailable.", status: 503 });
  });
});

describe("chain time validation", () => {
  it("reads unix time only from the canonical nonexecutable Clock sysvar", () => {
    expect(escrowClock(clockAccount(), BigInt(500))).toBe(1000);
    expect(() => escrowClock({ ...clockAccount(), programAddress: address(PROGRAM) }, BigInt(500))).toThrow();
    expect(() => escrowClock({ ...clockAccount(), executable: true }, BigInt(500))).toThrow();
    expect(() => escrowClock(clockAccount(), BigInt(501))).toThrow();
    expect(() => escrowClock(null, BigInt(500))).toThrow();
  });
});
