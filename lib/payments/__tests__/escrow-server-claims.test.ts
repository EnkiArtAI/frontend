import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { address, createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from "@solana/kit";
import { AccountState, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { SupabaseClient } from "@supabase/supabase-js";
import { escrowAddresses, escrowMint } from "../escrow/addresses";
import type { EscrowChainAccount } from "../escrow/confirmation";
import { EscrowState, getEscrowDecoder, getEscrowEncoder } from "../escrow/generated";
import type { EscrowBank, EscrowChain } from "../escrow/server-chain";
import type { EscrowDepositRow } from "../escrow/server-deposit";
import {
  claimGenerationEscrowUnit, closeGenerationEscrowBatch, deliverGenerationEscrowUnit, failGenerationEscrowUnit,
  type GenerationEscrowBatch, type GenerationEscrowUnitClaim,
} from "../escrow/server-claims";

const ID = "00112233-4455-6677-8899-aabbccddeeff";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const GENERATION = "33333333-3333-4333-8333-333333333333";
const PROGRAM = address("hNNT7mTmthTVvnw4NYo6jYoBTDazRgweWTBHBmwgcak");
let buyer: KeyPairSigner, operator: KeyPairSigner, artist: KeyPairSigner, treasury: KeyPairSigner;
beforeAll(async () => {
  [buyer, operator, artist, treasury] = await Promise.all([1, 2, 3, 4].map(seed =>
    createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(seed))));
});
interface Unit {
  intent_id: string; unit_index: number; state: "running" | "delivered" | "failed";
  claim_token: string; user_id: string; generation_id: string | null;
}
async function fixture() {
  const derived = await escrowAddresses(PROGRAM, buyer.address, ID);
  const intent = { id: ID, buyer_wallet: USER, artist_wallet: artist.address, total_micro: 200_000, artist_amount_micro: 100_000 };
  const recovery = { units: 4, mint: escrowMint("solana-devnet"), treasury_unit_micro: "110000", artist_unit_micro: "90000", recovery_unit_micro: "10000" };
  const row: EscrowDepositRow = {
    intent_id: ID, program_address: PROGRAM, cluster: "solana-devnet", buyer_address: buyer.address,
    rent_payer: operator.address, treasury_owner: treasury.address, escrow_address: derived.escrow,
    vault_address: derived.vault, unsigned_transaction: "\\x00", message: "\\x00", blockhash: "unused",
    last_valid_block_height: 1800, chain_now_seconds: 1000, expires_at_seconds: 2800,
    state: "funded", signed_transaction: "\\x00", signature: "confirmed", confirmed_slot: "300",
  };
  const escrow: EscrowChainAccount = { address: derived.escrow, programAddress: PROGRAM, executable: false,
    data: getEscrowEncoder().encode({ version: 1, buyer: buyer.address, mint: recovery.mint,
      intentId: derived.intentBytes, units: 4, recipientCount: 2, recipientOwners: [treasury.address, artist.address],
      unitAmounts: [110_000, 90_000], expiresAt: 2800, createdAt: 1000, state: EscrowState.Funded,
      settledUnits: 0, refundDue: 800_000, rentPayer: operator.address,
      bump: derived.escrowBump, vaultBump: derived.vaultBump }) };
  const vault: EscrowChainAccount = { address: derived.vault, programAddress: TOKEN_PROGRAM_ADDRESS, executable: false,
    data: getTokenEncoder().encode({ mint: escrowMint("solana-devnet"), owner: derived.escrow, amount: 800_001,
      delegate: null, state: AccountState.Initialized, isNative: null, delegatedAmount: 0, closeAuthority: null }) };
  const bank: EscrowBank = { slot: BigInt(301), chainNowSeconds: 1100, accounts: [escrow, vault] };
  const units = new Map<number, Unit>();
  let batch: GenerationEscrowBatch = { intent_id: ID, state: "open", delivered_units: null, settlement_signature: null };
  const events: string[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code: string; message?: string } | null }> => {
    events.push(name);
    if (args.p_owner_wallet !== intent.buyer_wallet) return { data: null, error: { code: "22023" } };
    const index = args.p_unit_index as number;
    const unit = units.get(index);
    switch (name) {
      case "claim_generation_escrow_unit": {
        if (unit || args.p_user_id !== USER || (args.p_chain_now_seconds as number) + 420 >= 2800) return { data: [], error: null };
        const acquired: Unit = { intent_id: ID, unit_index: index, state: "running", claim_token: args.p_claim_token as string,
          user_id: USER, generation_id: null };
        units.set(index, acquired);
        return { data: [acquired], error: null };
      }
      case "deliver_generation_escrow_unit": {
        if (!unit || unit.claim_token !== args.p_claim_token || unit.state === "failed" || args.p_generation_id !== GENERATION) {
          return { data: null, error: { code: "22023", message: "private database detail" } };
        }
        const delivered: Unit = { ...unit, state: "delivered", generation_id: GENERATION };
        units.set(index, delivered);
        return { data: delivered, error: null };
      }
      case "fail_generation_escrow_unit": {
        if (!unit || unit.state !== "running" || unit.claim_token !== args.p_claim_token) return { data: null, error: null };
        const failed: Unit = { ...unit, state: "failed" };
        units.set(index, failed);
        return { data: failed, error: null };
      }
      case "close_generation_escrow_batch": return { data: batch, error: null };
      default: throw new Error(`Unexpected fixture RPC ${name}`);
    }
  });
  const db = {
    rpc,
    from(table: string) {
      const filters = new Map<string, unknown>();
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.set(key, value); return query; },
        single: async () => ({ data: recovery, error: null }),
        maybeSingle: async () => ({ data: table === "generation_payment_intents"
          ? (filters.get("id") === ID && filters.get("buyer_wallet") === intent.buyer_wallet ? intent : null)
          : row, error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const chain: EscrowChain = {
    programAddress: PROGRAM, cluster: "solana-devnet", operatorAddress: operator.address,
    accounts: vi.fn(async () => { events.push("bank"); return bank; }),
    operatorKeyPair: vi.fn(async () => operator.keyPair),
    lifetime: vi.fn(), height: vi.fn(), finalizedHeight: vi.fn(), receipt: vi.fn(), broadcast: vi.fn(),
  };
  const updateEscrow = (changes: Partial<ReturnType<ReturnType<typeof getEscrowDecoder>["decode"]>>) => {
    escrow.data = getEscrowEncoder().encode({ ...getEscrowDecoder().decode(escrow.data), ...changes });
  };
  return { db, rpc, chain, row, intent, bank, escrow, vault, units, events, updateEscrow,
    setBatch: (value: GenerationEscrowBatch) => { batch = value; } };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { f = await fixture(); });
const claim = (unitIndex = 0, owner = USER, userId = USER) =>
  claimGenerationEscrowUnit(f.db, f.chain, { intentId: ID, owner, userId, unitIndex });

describe("funded image-unit admission", () => {
  it("verifies one canonical bank after the persisted confirmation, then acquires a server-token claim", async () => {
    const acquired = await claim(2);
    expect(acquired).toEqual({ intentId: ID, owner: USER, userId: USER, unitIndex: 2, claimToken: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(f.chain.accounts).toHaveBeenCalledWith([f.escrow.address, f.vault.address], "confirmed", BigInt(300));
    expect(f.rpc).toHaveBeenCalledWith("claim_generation_escrow_unit", {
      p_intent_id: ID, p_owner_wallet: USER, p_user_id: USER, p_unit_index: 2,
      p_claim_token: acquired.claimToken, p_chain_now_seconds: 1100, p_admitted_slot: "301",
    });
    expect(f.events).toEqual(["bank", "claim_generation_escrow_unit"]);
    expect(f.chain.operatorKeyPair).not.toHaveBeenCalled();
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });
  it("rejects another owner's intent before any chain or claim call", async () => {
    await expect(claim(0, OTHER_USER)).rejects.toMatchObject({ status: 404 });
    expect(f.chain.accounts).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("uses the authenticated users.id for SQL's owner-to-user binding", async () => {
    f.intent.buyer_wallet = buyer.address;
    const acquired = await claim(0, buyer.address);
    expect(acquired.owner).toBe(buyer.address);
    expect(acquired.userId).toBe(USER);
    await expect(claim(1, buyer.address, OTHER_USER)).rejects.toMatchObject({ status: 409 });
    expect(f.units.has(1)).toBe(false);
  });
  it.each([-1, 24, 0.5, NaN])("rejects invalid unit index %s before reading money", async index => {
    await expect(claim(index)).rejects.toMatchObject({ status: 400 });
    expect(f.chain.accounts).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("rejects indexes beyond this deposit's bought units", async () => {
    await expect(claim(4)).rejects.toMatchObject({ status: 409 });
    expect(f.chain.accounts).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("requires the funded state and a positive exact persisted slot", async () => {
    f.row.state = "submitted";
    await expect(claim()).rejects.toMatchObject({ status: 409 });
    f.row.state = "funded";
    for (const slot of [null, 0, "-1", "3.1", Number.MAX_SAFE_INTEGER + 1]) {
      f.row.confirmed_slot = slot;
      await expect(claim()).rejects.toMatchObject({ status: 503 });
    }
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.chain.accounts).not.toHaveBeenCalled();
  });
  it("does not trust a funded database row with a forged vault program owner", async () => {
    f.vault.programAddress = PROGRAM;
    await expect(claim()).rejects.toMatchObject({ status: 409 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("does not trust an escrow whose buyer differs from the stored wallet", async () => {
    f.updateEscrow({ buyer: artist.address });
    await expect(claim()).rejects.toMatchObject({ status: 409 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(["settled", "refundDue", "canonical", "missing"])("does not admit altered %s accounts", async alteration => {
    if (alteration === "settled") f.updateEscrow({ state: EscrowState.Settled, settledUnits: 1 });
    if (alteration === "refundDue") f.updateEscrow({ refundDue: BigInt(1) });
    if (alteration === "canonical") f.escrow.address = artist.address;
    if (alteration === "missing") f.bank.accounts[1] = null;
    await expect(claim()).rejects.toMatchObject({ status: 409 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("rejects a stale bank and non-monotonic chain clock", async () => {
    f.bank.slot = BigInt(299);
    await expect(claim()).rejects.toMatchObject({ status: 503 });
    f.bank.slot = BigInt(301);
    f.bank.chainNowSeconds = 999;
    await expect(claim()).rejects.toMatchObject({ status: 503 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("expired funds remain refundable but never authorize another provider invocation", async () => {
    f.bank.chainNowSeconds = 2800;
    await expect(claim()).rejects.toMatchObject({ status: 409 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("honors SQL's generation and settlement margin", async () => {
    f.bank.chainNowSeconds = 2380;
    await expect(claim()).rejects.toMatchObject({ status: 409 });
    expect(f.units.size).toBe(0);
  });
  it("retries and concurrent duplicate claims never start another provider call", async () => {
    const results = await Promise.allSettled([claim(), claim()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(f.units.size).toBe(1);
    await expect(claim()).rejects.toMatchObject({ status: 409 });
  });
  it("does not pass request-derived delivery counts to the admission RPC", async () => {
    await claim();
    const args = f.rpc.mock.calls[0][1];
    expect(Object.keys(args).sort()).toEqual(["p_admitted_slot", "p_chain_now_seconds", "p_claim_token", "p_intent_id", "p_owner_wallet", "p_unit_index", "p_user_id"]);
  });
  it("rejects a mismatched acquired token before a provider could be invoked", async () => {
    f.rpc.mockResolvedValue({ data: [{ intent_id: ID, unit_index: 0, state: "running", claim_token: OTHER_USER, user_id: USER }], error: null });
    await expect(claim()).rejects.toMatchObject({ status: 503 });
  });
  it("replaces database and transport detail with plain payment errors", async () => {
    f.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "private database detail" } });
    await expect(claim()).rejects.toMatchObject({ status: 503, message: "Payments are temporarily unavailable. Please try again later." });
    vi.mocked(f.chain.accounts).mockRejectedValue(new Error("private transport detail"));
    await expect(claim()).rejects.toMatchObject({ status: 503, message: "Payments are temporarily unavailable. Please try again later." });
  });
});

describe("durable delivery accounting", () => {
  it("marks a generated image delivered only under the server's original claim, idempotently", async () => {
    const acquired = await claim();
    await deliverGenerationEscrowUnit(f.db, acquired, GENERATION);
    await deliverGenerationEscrowUnit(f.db, acquired, GENERATION);
    expect(f.units.get(0)).toMatchObject({ state: "delivered", generation_id: GENERATION });
    expect(f.rpc).toHaveBeenCalledWith("deliver_generation_escrow_unit", {
      p_intent_id: ID, p_owner_wallet: USER, p_unit_index: 0,
      p_claim_token: acquired.claimToken, p_generation_id: GENERATION,
    });
    await expect(claim()).rejects.toMatchObject({ status: 409 });
  });
  it("requires an actual recorded generation and never exposes the database's detail", async () => {
    const acquired = await claim();
    await expect(deliverGenerationEscrowUnit(f.db, acquired, OTHER_USER)).rejects.toMatchObject({ status: 409 });
    expect(f.units.get(0)?.state).toBe("running");
    await expect(deliverGenerationEscrowUnit(f.db, acquired, "request-selected-generation")).rejects.toMatchObject({ status: 409 });
  });
  it("rejects a different claim token or mismatched delivered response", async () => {
    const acquired = await claim();
    await expect(deliverGenerationEscrowUnit(f.db, { ...acquired, claimToken: OTHER_USER }, GENERATION)).rejects.toMatchObject({ status: 409 });
    f.rpc.mockResolvedValue({ data: { ...f.units.get(0), state: "delivered", generation_id: GENERATION, user_id: OTHER_USER }, error: null });
    await expect(deliverGenerationEscrowUnit(f.db, acquired, GENERATION)).rejects.toMatchObject({ status: 503 });
  });
  it("failure is final and a repeated failure does not re-admit the unit", async () => {
    const acquired = await claim();
    await failGenerationEscrowUnit(f.db, acquired);
    await failGenerationEscrowUnit(f.db, acquired);
    expect(f.units.get(0)?.state).toBe("failed");
    await expect(claim()).rejects.toMatchObject({ status: 409 });
    await expect(deliverGenerationEscrowUnit(f.db, acquired, GENERATION)).rejects.toMatchObject({ status: 409 });
  });
  it("a late failure never erases an already delivered image", async () => {
    const acquired = await claim();
    await deliverGenerationEscrowUnit(f.db, acquired, GENERATION);
    await failGenerationEscrowUnit(f.db, acquired);
    expect(f.units.get(0)).toMatchObject({ state: "delivered", generation_id: GENERATION });
  });
  it("rejects malformed internal claims before any delivery or failure RPC", async () => {
    const malformed: GenerationEscrowUnitClaim = { intentId: ID, owner: USER, userId: USER, unitIndex: 24, claimToken: OTHER_USER };
    await expect(failGenerationEscrowUnit(f.db, malformed)).rejects.toMatchObject({ status: 409 });
    await expect(deliverGenerationEscrowUnit(f.db, malformed, GENERATION)).rejects.toMatchObject({ status: 409 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
});

describe("batch closing", () => {
  it("takes fresh bank time and freezes SQL's delivered count, never a request count", async () => {
    f.setBatch({ intent_id: ID, state: "ready", delivered_units: 2, settlement_signature: null });
    const result = await closeGenerationEscrowBatch(f.db, f.chain, ID, USER);
    expect(result).toMatchObject({ state: "ready", delivered_units: 2 });
    expect(f.chain.accounts).toHaveBeenCalledWith([f.escrow.address, f.vault.address], "confirmed", BigInt(300));
    expect(f.rpc).toHaveBeenCalledWith("close_generation_escrow_batch", {
      p_intent_id: ID, p_owner_wallet: USER, p_chain_now_seconds: 1100, p_cancel: false,
    });
  });
  it("lets expired or settled funds close and preserves an in-flight cancellation", async () => {
    f.bank.chainNowSeconds = 2801;
    f.updateEscrow({ state: EscrowState.Settled, settledUnits: 2 });
    f.setBatch({ intent_id: ID, state: "closing", delivered_units: null, settlement_signature: null });
    expect(await closeGenerationEscrowBatch(f.db, f.chain, ID, USER, true)).toMatchObject({ state: "closing" });
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_cancel: true, p_chain_now_seconds: 2801 });
  });
  it("keeps final zero-image refunds idempotent even after chain accounts are closed", async () => {
    f.bank.accounts = [null, null];
    f.setBatch({ intent_id: ID, state: "closed", delivered_units: 0, settlement_signature: null });
    expect(await closeGenerationEscrowBatch(f.db, f.chain, ID, USER)).toMatchObject({ state: "closed", delivered_units: 0 });
  });
  it("rejects unowned closing before any network or SQL call", async () => {
    await expect(closeGenerationEscrowBatch(f.db, f.chain, ID, OTHER_USER)).rejects.toMatchObject({ status: 404 });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.chain.accounts).not.toHaveBeenCalled();
  });
  it("rejects impossible frozen counts and an open batch with a frozen count", async () => {
    for (const batch of [
      { intent_id: ID, state: "ready" as const, delivered_units: 5, settlement_signature: null },
      { intent_id: ID, state: "open" as const, delivered_units: 0, settlement_signature: null },
    ]) {
      f.setBatch(batch);
      await expect(closeGenerationEscrowBatch(f.db, f.chain, ID, USER)).rejects.toMatchObject({ status: 503 });
    }
  });
});
