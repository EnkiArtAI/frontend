import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  address, blockhash, createKeyPairSignerFromPrivateKeyBytes, getTransactionDecoder,
  getTransactionEncoder, partiallySignTransaction, type KeyPairSigner,
} from "@solana/kit";
import { AccountState, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { EscrowChainAccount } from "../escrow/confirmation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { escrowAddresses, escrowMint } from "../escrow/addresses";
import { getConfigEncoder, getEscrowEncoder, EscrowState } from "../escrow/generated";
import { coSignEscrowDeposit, prepareEscrowDeposit } from "../escrow/deposit";
import { prepareGenerationEscrow, submitGenerationEscrow, generationEscrowStatus, expireUnfundedGenerationEscrow, type EscrowDepositRow } from "../escrow/server-deposit";
import type { EscrowChain } from "../escrow/server-chain";

const ID = "00112233-4455-6677-8899-aabbccddeeff";
const PROGRAM = address("hNNT7mTmthTVvnw4NYo6jYoBTDazRgweWTBHBmwgcak");
const lifetime = { blockhash: blockhash("6zRZaKfDGdKRvSaBnFVE9RarFAbn9DsWwVAKrTLbLNKZ"), lastValidBlockHeight: BigInt(1800) };
let buyer: KeyPairSigner, operator: KeyPairSigner, artist: KeyPairSigner, treasury: KeyPairSigner;
beforeAll(async () => {
  [buyer, operator, artist, treasury] = await Promise.all([1, 2, 3, 4].map(seed =>
    createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(seed))));
});
const bytea = (base64: string) => `\\x${Buffer.from(base64, "base64").toString("hex")}`;
async function fixture() {
  const derived = await escrowAddresses(PROGRAM, buyer.address, ID);
  const plan = {
    programAddress: PROGRAM, cluster: "solana-devnet" as const, intentId: ID,
    buyer: buyer.address, rentPayer: operator.address, treasuryOwner: treasury.address, artistOwner: artist.address,
    units: 4, treasuryUnitMicro: 110_000, artistUnitMicro: 90_000,
    chainNowSeconds: 1000, expiresAtSeconds: 2800, maxDepositMicro: 40_000_000,
  };
  const config: EscrowChainAccount = { address: derived.config, programAddress: PROGRAM, executable: false,
    data: getConfigEncoder().encode({ admin: treasury.address, guardian: treasury.address, operator: operator.address,
      treasuryOwner: treasury.address, paused: false, maxDepositMicro: 40_000_000, minTtlS: 600,
      maxTtlS: 1800, refundAtaFeeMicro: 1000, bump: derived.configBump }) };
  const escrow: EscrowChainAccount = { address: derived.escrow, programAddress: PROGRAM, executable: false,
    data: getEscrowEncoder().encode({ version: 1, buyer: buyer.address, mint: escrowMint(plan.cluster),
      intentId: derived.intentBytes, units: 4, recipientCount: 2, recipientOwners: [treasury.address, artist.address],
      unitAmounts: [110_000, 90_000], expiresAt: 2800, createdAt: 1000, state: EscrowState.Funded,
      settledUnits: 0, refundDue: 800_000,
      rentPayer: operator.address, bump: derived.escrowBump, vaultBump: derived.vaultBump }) };
  const vault: EscrowChainAccount = { address: derived.vault, programAddress: TOKEN_PROGRAM_ADDRESS, executable: false,
    data: getTokenEncoder().encode({ mint: escrowMint(plan.cluster), owner: derived.escrow, amount: 800_001,
      delegate: null, state: AccountState.Initialized, isNative: null, delegatedAmount: 0, closeAuthority: null }) };
  const prepared = await prepareEscrowDeposit(plan, lifetime);
  const transaction = getTransactionDecoder().decode(Buffer.from(prepared.unsignedTransactionBase64, "base64"));
  const signed = await partiallySignTransaction([buyer.keyPair], transaction);
  const buyerWire = Buffer.from(getTransactionEncoder().encode(signed)).toString("base64");
  const fullySigned = await coSignEscrowDeposit(prepared, buyerWire, operator.keyPair);
  const intent = { id: ID, buyer_wallet: buyer.address, artist_wallet: artist.address, total_micro: 200_000, artist_amount_micro: 100_000 };
  const recovery = { units: 4, mint: escrowMint(plan.cluster), treasury_unit_micro: "110000", artist_unit_micro: "90000", recovery_unit_micro: "10000" };
  let row: EscrowDepositRow | null = null;
  const makeRow = (): EscrowDepositRow => ({
    intent_id: ID, program_address: PROGRAM, cluster: plan.cluster, buyer_address: buyer.address,
    rent_payer: operator.address, treasury_owner: treasury.address, escrow_address: derived.escrow,
    vault_address: derived.vault, unsigned_transaction: bytea(prepared.unsignedTransactionBase64),
    message: bytea(prepared.messageBase64), blockhash: lifetime.blockhash, last_valid_block_height: 1800,
    chain_now_seconds: 1000, expires_at_seconds: 2800, state: "prepared", signed_transaction: null,
    signature: null, confirmed_slot: null,
  });
  const events: string[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code: string } | null }> => {
    events.push(name);
    switch (name) {
      case "reserve_generation_escrow_recovery": return { data: recovery, error: null };
      case "prepare_generation_escrow_deposit":
        row ??= { ...makeRow(), message: args.p_message as string, unsigned_transaction: args.p_unsigned_transaction as string };
        return { data: row, error: null };
      case "begin_generation_escrow_submit":
        if (row?.state !== "prepared") return { data: [], error: null };
        row = { ...row, state: "submitting" }; return { data: [row], error: null };
      case "store_generation_escrow_signed_deposit":
        if (!row) throw new Error("fixture missing");
        row = { ...row, state: "submitted", signed_transaction: args.p_signed_transaction as string, signature: args.p_signature as string };
        return { data: row, error: null };
      case "expire_unfunded_generation_escrow_deposit":
        if (!row) throw new Error("fixture missing");
        row = { ...row, state: "expired" }; return { data: row, error: null };
      case "confirm_generation_escrow_deposit":
        if (!row) throw new Error("fixture missing");
        row = { ...row, state: "funded", confirmed_slot: args.p_confirmed_slot as string }; return { data: row, error: null };
      default: throw new Error(`Unexpected test RPC ${name}`);
    }
  });
  const db = {
    rpc,
    from(table: string) {
      const filters = new Map<string, unknown>();
      const query = {
        select: () => query, eq: (key: string, value: unknown) => { filters.set(key, value); return query; }, is: () => query,
        single: async () => ({ data: recovery, error: null }),
        maybeSingle: async () => ({ data:
          table === "generation_payment_intents" ? (!filters.has("buyer_wallet") || filters.get("buyer_wallet") === intent.buyer_wallet ? intent : null) :
          table === "user_wallets" ? { address: buyer.address } : row, error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const chain: EscrowChain = {
    programAddress: PROGRAM, cluster: plan.cluster, operatorAddress: operator.address,
    operatorKeyPair: vi.fn(async () => { events.push("key"); return operator.keyPair; }),
    accounts: vi.fn(async (addresses, _commitment, minimumSlot) => ({
      slot: minimumSlot ?? BigInt(200), chainNowSeconds: 1000,
      accounts: addresses.length === 1 ? [config] : [escrow, vault],
    })),
    lifetime: vi.fn(async () => lifetime), height: vi.fn(async () => BigInt(1700)),
    finalizedHeight: vi.fn(async () => BigInt(1801)),
    receipt: vi.fn(async () => null),
    broadcast: vi.fn(async () => { events.push("broadcast"); return fullySigned.depositSignature; }),
  };
  return { db, rpc, chain, intent, recovery, plan, config, escrow, vault, prepared, buyerWire, fullySigned, events,
    setRow: (value = makeRow()) => { row = value; }, getRow: () => row, makeRow };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { f = await fixture(); });
const submit = () => submitGenerationEscrow(f.db, f.chain, { intentId: ID, owner: buyer.address, signedTransaction: f.buyerWire });

describe("server-built Escrow deposits", () => {
  it("reads the cap from verified Config and takes recovery amounts only from SQL", async () => {
    const result = await prepareGenerationEscrow(f.db, f.chain, { intentId: ID, owner: buyer.address, units: 4 });
    expect(result.transaction).toBe(f.prepared.unsignedTransactionBase64);
    expect(f.rpc.mock.calls[0]).toEqual(["reserve_generation_escrow_recovery", {
      p_intent_id: ID, p_units: 4, p_mint: escrowMint("solana-devnet"), p_max_deposit_micro: 40_000_000,
    }]);
  });
  it("rejects an unowned intent before reading Chain accounts or signing", async () => {
    await expect(prepareGenerationEscrow(f.db, f.chain, { intentId: ID, owner: artist.address, units: 4 })).rejects.toMatchObject({ status: 404 });
    expect(f.chain.accounts).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it("rejects a forged Config owner before reserving money", async () => {
    f.config.programAddress = treasury.address;
    await expect(prepareGenerationEscrow(f.db, f.chain, { intentId: ID, owner: buyer.address, units: 4 })).rejects.toMatchObject({ status: 503 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("returns the first stored message on repeat preparation, without rebuilding", async () => {
    f.setRow();
    const result = await prepareGenerationEscrow(f.db, f.chain, { intentId: ID, owner: buyer.address, units: 4 });
    expect(result.transaction).toBe(f.prepared.unsignedTransactionBase64);
    expect(f.chain.lifetime).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
    await expect(prepareGenerationEscrow(f.db, f.chain, { intentId: ID, owner: buyer.address, units: 3 })).rejects.toMatchObject({ status: 409 });
  });
  it("a missing or invalid buyer signature never acquires the lease", async () => {
    f.setRow();
    await expect(submitGenerationEscrow(f.db, f.chain, { intentId: ID, owner: buyer.address,
      signedTransaction: f.prepared.unsignedTransactionBase64 })).rejects.toMatchObject({ status: 400 });
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.chain.operatorKeyPair).not.toHaveBeenCalled();
  });
  it("persists the exact co-signed wire before broadcast and does not count processing as funded", async () => {
    f.setRow();
    const result = await submit();
    expect(result).toMatchObject({ state: "submitted", funded: false });
    expect(f.events).toEqual(["begin_generation_escrow_submit", "key", "store_generation_escrow_signed_deposit", "broadcast"]);
    expect(f.chain.broadcast).toHaveBeenCalledWith(f.fullySigned.signedTransactionBase64);
  });
  it("leaves the database error code in the log before answering 503 (devnet 2026-10-13)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === "prepare_generation_escrow_deposit"
      ? { data: null, error: { code: "23514", message: "fixture check" } as never }
      : original(name, args));
    await expect(prepareGenerationEscrow(f.db, f.chain, { intentId: ID, owner: buyer.address, units: 4 })).rejects.toMatchObject({ status: 503 });
    expect(log).toHaveBeenCalledWith("[escrow] db error", "23514", "fixture check");
    log.mockRestore();
  });
  it("does not broadcast if signed-wire persistence fails", async () => {
    f.setRow();
    f.rpc.mockImplementation(async (name) => ({ data: name === "begin_generation_escrow_submit" ? [f.makeRow()] : null,
      error: name === "store_generation_escrow_signed_deposit" ? { code: "PGRST" } : null }));
    await expect(submit()).rejects.toMatchObject({ status: 503 });
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });
  it("never takes over another submitting process", async () => {
    f.setRow({ ...f.makeRow(), state: "submitting" });
    expect(await submit()).toMatchObject({ state: "submitting", funded: false });
    expect(f.chain.operatorKeyPair).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it("confirms only matching escrow and vault from a bank at the signature slot", async () => {
    f.setRow({ ...f.makeRow(), state: "submitted", signed_transaction: bytea(f.fullySigned.signedTransactionBase64), signature: f.fullySigned.depositSignature });
    vi.mocked(f.chain.receipt).mockResolvedValue({ slot: BigInt(300), commitment: "confirmed", failed: false });
    expect(await submit()).toMatchObject({ state: "funded", funded: true });
    expect(f.chain.accounts).toHaveBeenCalledWith([f.escrow.address, f.vault.address], "confirmed", BigInt(300));
    expect(f.chain.operatorKeyPair).not.toHaveBeenCalled(); expect(f.chain.broadcast).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledWith("confirm_generation_escrow_deposit", {
      p_intent_id: ID, p_owner_wallet: buyer.address, p_signature: f.fullySigned.depositSignature, p_confirmed_slot: "300",
    });
  });
  it("a confirmed signature with the wrong vault owner never authorizes generation", async () => {
    f.setRow({ ...f.makeRow(), state: "submitted", signature: f.fullySigned.depositSignature });
    f.vault.programAddress = PROGRAM;
    vi.mocked(f.chain.receipt).mockResolvedValue({ slot: BigInt(300), commitment: "confirmed", failed: false });
    await expect(generationEscrowStatus(f.db, f.chain, ID, buyer.address)).rejects.toMatchObject({ status: 409 });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("an expired blockhash is never replaced or broadcast again", async () => {
    f.setRow({ ...f.makeRow(), state: "submitted", signed_transaction: bytea(f.fullySigned.signedTransactionBase64), signature: f.fullySigned.depositSignature });
    vi.mocked(f.chain.height).mockResolvedValue(BigInt(1801));
    expect(await submit()).toMatchObject({ state: "submitted", funded: false });
    expect(f.chain.broadcast).not.toHaveBeenCalled(); expect(f.chain.lifetime).not.toHaveBeenCalled();
  });
  it("an ambiguous network error retains the immutable submitted payment for retry", async () => {
    f.setRow();
    vi.mocked(f.chain.broadcast).mockRejectedValue(new (await import("../escrow/server-chain")).EscrowPaymentError(503, "Network unavailable"));
    expect(await submit()).toMatchObject({ state: "submitted", funded: false });
    expect(f.getRow()?.signed_transaction).toBe(bytea(f.fullySigned.signedTransactionBase64));
  });
});

describe("unfunded deposit expiry", () => {
  const expire = () => expireUnfundedGenerationEscrow(f.db, f.chain, ID, buyer.address);
  it("requires both canonical PDAs absent after blockhash expiry at one finalized bank", async () => {
    f.setRow();
    vi.mocked(f.chain.accounts).mockResolvedValue({ slot: BigInt(400), chainNowSeconds: 1001, accounts: [null, null] });
    expect(await expire()).toMatchObject({ state: "expired", funded: false });
    expect(f.chain.finalizedHeight).toHaveBeenCalledWith(BigInt(400));
    expect(f.rpc).toHaveBeenCalledWith("expire_unfunded_generation_escrow_deposit", {
      p_intent_id: ID, p_owner_wallet: buyer.address, p_finalized_block_height: "1801", p_absence_checked_slot: "400",
    });
  });
  it("neither wall-clock expiry nor an extant vault cancels the reservation", async () => {
    f.setRow();
    vi.mocked(f.chain.accounts).mockResolvedValue({ slot: BigInt(400), chainNowSeconds: 4000, accounts: [null, null] });
    vi.mocked(f.chain.finalizedHeight).mockResolvedValue(BigInt(1800));
    expect(await expire()).toMatchObject({ state: "prepared" });
    expect(f.rpc).not.toHaveBeenCalled();
    vi.mocked(f.chain.finalizedHeight).mockResolvedValue(BigInt(1801));
    vi.mocked(f.chain.accounts).mockResolvedValue({ slot: BigInt(400), chainNowSeconds: 4000, accounts: [null, f.vault] });
    expect(await expire()).toMatchObject({ state: "prepared" });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("never declares a landed or merely processing signature unfunded", async () => {
    f.setRow({ ...f.makeRow(), state: "submitted", signature: f.fullySigned.depositSignature });
    vi.mocked(f.chain.receipt).mockResolvedValue({ slot: BigInt(300), commitment: "processed", failed: false });
    expect(await expire()).toMatchObject({ state: "submitted" });
    expect(f.chain.accounts).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
});

