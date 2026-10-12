import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  address, blockhash, createKeyPairSignerFromPrivateKeyBytes,
  getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder,
  type KeyPairSigner,
} from "@solana/kit";
import { AccountState, getTokenDecoder, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { SupabaseClient } from "@supabase/supabase-js";
import { escrowAddresses, escrowMint, escrowTokenAddress } from "../escrow/addresses";
import type { EscrowChainAccount } from "../escrow/confirmation";
import { EscrowState, getConfigDecoder, getConfigEncoder, getEscrowDecoder, getEscrowEncoder, SETTLE_DISCRIMINATOR, RECLAIM_DISCRIMINATOR } from "../escrow/generated";
import { prepareEscrowReclaim, prepareEscrowSettlement } from "../escrow/lifecycle";
import { advanceGenerationEscrow } from "../escrow/server-lifecycle";
import type { EscrowDepositRow } from "../escrow/server-deposit";
import type { GenerationEscrowBatch } from "../escrow/server-claims";
import { EscrowPaymentError, type EscrowBank, type EscrowChain, type EscrowReceipt } from "../escrow/server-chain";

const ID = "00112233-4455-6677-8899-aabbccddeeff";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const PROGRAM = address("hNNT7mTmthTVvnw4NYo6jYoBTDazRgweWTBHBmwgcak");
const lifetime = { blockhash: blockhash("6zRZaKfDGdKRvSaBnFVE9RarFAbn9DsWwVAKrTLbLNKZ"), lastValidBlockHeight: BigInt(1800) };
let buyer: KeyPairSigner, operator: KeyPairSigner, artist: KeyPairSigner, treasury: KeyPairSigner, nextOperator: KeyPairSigner;
beforeAll(async () => {
  [buyer, operator, artist, treasury, nextOperator] = await Promise.all([1, 2, 3, 4, 5].map(seed =>
    createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(seed))));
});
const bytea = (base64: string) => `\\x${Buffer.from(base64, "base64").toString("hex")}`;
const decode = (base64: string) => {
  const transaction = getTransactionDecoder().decode(Buffer.from(base64, "base64"));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== "legacy") throw new Error("Expected a legacy lifecycle wire");
  return { transaction, message };
};
interface Attempt {
  id: string; intent_id: string; kind: "settle" | "reclaim"; state: "submitted" | "confirmed" | "expired";
  signed_transaction: string; signature: string; blockhash: string; last_valid_block_height: string | number;
  confirmed_slot: string | null;
}

async function fixture() {
  const derived = await escrowAddresses(PROGRAM, buyer.address, ID);
  const plan = { programAddress: PROGRAM, cluster: "solana-devnet" as const, intentId: ID,
    buyer: buyer.address, rentPayer: operator.address, treasuryOwner: treasury.address, artistOwner: artist.address,
    units: 4, treasuryUnitMicro: 110_000, artistUnitMicro: 90_000, chainNowSeconds: 1000, expiresAtSeconds: 2800 };
  const intent = { id: ID, buyer_wallet: USER, artist_wallet: artist.address, total_micro: 200_000, artist_amount_micro: 100_000 };
  const recovery = { units: 4, mint: escrowMint(plan.cluster), treasury_unit_micro: "110000", artist_unit_micro: "90000", recovery_unit_micro: "10000" };
  const deposit: EscrowDepositRow = { intent_id: ID, program_address: PROGRAM, cluster: plan.cluster,
    buyer_address: buyer.address, rent_payer: operator.address, treasury_owner: treasury.address,
    escrow_address: derived.escrow, vault_address: derived.vault, unsigned_transaction: "\\x00", message: "\\x00",
    blockhash: lifetime.blockhash, last_valid_block_height: "1800", chain_now_seconds: 1000, expires_at_seconds: 2800,
    state: "funded", signed_transaction: "\\x00", signature: "confirmed-deposit", confirmed_slot: "300" };
  const config: EscrowChainAccount = { address: derived.config, programAddress: PROGRAM, executable: false,
    data: getConfigEncoder().encode({ admin: treasury.address, guardian: treasury.address,
      operator: operator.address, treasuryOwner: treasury.address, paused: false, maxDepositMicro: 40_000_000,
      minTtlS: 600, maxTtlS: 1800, refundAtaFeeMicro: 1000, bump: derived.configBump }) };
  const escrow: EscrowChainAccount = { address: derived.escrow, programAddress: PROGRAM, executable: false,
    data: getEscrowEncoder().encode({ version: 1, buyer: buyer.address, mint: escrowMint(plan.cluster),
      intentId: derived.intentBytes, units: 4, recipientCount: 2, recipientOwners: [treasury.address, artist.address],
      unitAmounts: [110_000, 90_000], expiresAt: 2800, createdAt: 1000, state: EscrowState.Funded,
      settledUnits: 0, refundDue: 800_000, rentPayer: operator.address,
      bump: derived.escrowBump, vaultBump: derived.vaultBump }) };
  const vault: EscrowChainAccount = { address: derived.vault, programAddress: TOKEN_PROGRAM_ADDRESS, executable: false,
    data: getTokenEncoder().encode({ mint: escrowMint(plan.cluster), owner: derived.escrow, amount: 800_001,
      delegate: null, state: AccountState.Initialized, isNative: null, delegatedAmount: 0, closeAuthority: null }) };
  const bank: EscrowBank = { slot: BigInt(301), chainNowSeconds: 1100, accounts: [escrow, vault] };
  let batch: GenerationEscrowBatch = { intent_id: ID, state: "ready", delivered_units: 2, settlement_signature: null };
  let attempt: Attempt | null = null;
  let winningAttempt: Attempt | null = null;
  let deliveredCount = 2;
  const events: string[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code: string } | null }> => {
    events.push(name);
    if (args.p_owner_wallet !== USER) return { data: null, error: { code: "22023" } };
    switch (name) {
      case "ensure_generation_escrow_batch":
      case "close_generation_escrow_batch": return { data: batch, error: null };
      case "store_generation_escrow_transaction": {
        attempt = winningAttempt ?? (attempt?.state === "submitted" ? attempt : {
          id: ATTEMPT_ID, intent_id: ID, kind: args.p_kind as Attempt["kind"], state: "submitted",
          signed_transaction: args.p_signed_transaction as string, signature: args.p_signature as string,
          blockhash: args.p_blockhash as string, last_valid_block_height: args.p_last_valid_block_height as string,
          confirmed_slot: null,
        });
        return { data: attempt, error: null };
      }
      case "confirm_generation_escrow_transaction": {
        if (!attempt) throw new Error("Missing fixture attempt");
        attempt = { ...attempt, state: "confirmed", confirmed_slot: args.p_confirmed_slot as string };
        batch = { ...batch, state: attempt.kind === "settle" ? "settled" : "closed",
          settlement_signature: attempt.kind === "settle" ? attempt.signature : batch.settlement_signature };
        return { data: batch, error: null };
      }
      case "expire_generation_escrow_transaction": {
        if (!attempt) throw new Error("Missing fixture attempt");
        attempt = { ...attempt, state: "expired" }; return { data: attempt, error: null };
      }
      default: throw new Error(`Unexpected fixture RPC ${name}`);
    }
  });
  const db = { rpc, from(table: string) {
    const filters = new Map<string, unknown>();
    const q = {
      select: () => q, eq: (key: string, value: unknown) => { filters.set(key, value); return q; },
      in: (key: string, value: unknown[]) => { filters.set(key, value); return q; },
      order: () => q, limit: () => q,
      then: (resolve: (value: { data: { unit_index: number }[]; error: null }) => unknown) =>
        Promise.resolve({ data: Array.from({ length: deliveredCount }, (_, unit_index) => ({ unit_index })), error: null }).then(resolve),
      single: async () => ({ data: recovery, error: null }),
      maybeSingle: async () => ({ data: table === "generation_payment_intents"
        ? (filters.get("id") === ID && filters.get("buyer_wallet") === USER ? intent : null)
        : table === "generation_escrow_deposits" ? deposit
        : table === "generation_escrow_batches" ? batch
        : table === "generation_escrow_transactions"
          ? attempt && (!filters.has("kind") || filters.get("kind") === attempt.kind)
            && (!filters.has("state") || (Array.isArray(filters.get("state"))
              ? (filters.get("state") as unknown[]).includes(attempt.state) : filters.get("state") === attempt.state)) ? attempt : null
          : recovery, error: null }),
    };
    return q;
  } } as unknown as SupabaseClient;
  const chain: EscrowChain = {
    programAddress: PROGRAM, cluster: plan.cluster, operatorAddress: operator.address,
    operatorKeyPair: vi.fn(async () => { events.push("key"); return operator.keyPair; }),
    accounts: vi.fn(async (addresses, commitment) => {
      events.push(`bank:${commitment}`);
      return { ...bank,
        accounts: addresses.length === 1 ? [config] : bank.accounts };
    }),
    lifetime: vi.fn(async () => { events.push("lifetime"); return lifetime; }),
    height: vi.fn(async () => BigInt(1700)), finalizedHeight: vi.fn(async () => BigInt(1801)),
    receipt: vi.fn(async (): Promise<EscrowReceipt | null> => null),
    broadcast: vi.fn(async wire => { events.push("broadcast"); return getSignatureFromTransaction(decode(wire).transaction); }),
  };
  const updateEscrow = (changes: Partial<ReturnType<ReturnType<typeof getEscrowDecoder>["decode"]>>) => {
    escrow.data = getEscrowEncoder().encode({ ...getEscrowDecoder().decode(escrow.data), ...changes });
  };
  const updateVault = (changes: Partial<ReturnType<ReturnType<typeof getTokenDecoder>["decode"]>>) => {
    vault.data = getTokenEncoder().encode({ ...getTokenDecoder().decode(vault.data), ...changes });
  };
  const updateConfig = (changes: Partial<ReturnType<ReturnType<typeof getConfigDecoder>["decode"]>>) => {
    config.data = getConfigEncoder().encode({ ...getConfigDecoder().decode(config.data), ...changes });
  };
  const settledBank = (k = 2, forfeited = false) => {
    const refund = 800_000 - k * (forfeited ? 110_000 : 200_000);
    updateEscrow({ state: EscrowState.Settled, settledUnits: k, refundDue: BigInt(refund) });
    updateVault({ amount: BigInt(refund + 1) });
  };
  const makeAttempt = async (kind: Attempt["kind"] = "settle", nextLifetime = lifetime): Promise<Attempt> => {
    const wire = kind === "settle" ? await prepareEscrowSettlement(plan, 2, operator.keyPair, nextLifetime)
      : await prepareEscrowReclaim(plan, operator.keyPair, nextLifetime);
    return { id: ATTEMPT_ID, intent_id: ID, kind, state: "submitted", signed_transaction: bytea(wire.signedTransactionBase64),
      signature: wire.signature, blockhash: wire.blockhash, last_valid_block_height: wire.lastValidBlockHeight, confirmed_slot: null };
  };
  return { db, rpc, chain, intent, plan, deposit, config, escrow, vault, bank, derived, events,
    updateEscrow, updateVault, updateConfig, settledBank, makeAttempt,
    setBatch: (changes: Partial<GenerationEscrowBatch>) => { batch = { ...batch, ...changes }; },
    getBatch: () => batch, setAttempt: (value: Attempt | null) => { attempt = value; }, getAttempt: () => attempt,
    setWinningAttempt: (value: Attempt) => { winningAttempt = value; },
    setDeliveredCount: (count: number) => { deliveredCount = count; } };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { f = await fixture(); });
const advance = (owner = USER, cancel = false) => advanceGenerationEscrow(f.db, f.chain, ID, owner, cancel);
const rpcNames = () => f.rpc.mock.calls.map(([name]) => name);


describe("server settlement lifecycle", () => {
  it("rejects another owner before any chain read or mutation", async () => {
    await expect(advance(OTHER)).rejects.toMatchObject({ status: 404 });
    expect(f.chain.accounts).not.toHaveBeenCalled();
    expect(f.chain.receipt).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("waits for a funded deposit and running image claims", async () => {
    f.deposit.state = "submitted";
    await expect(advance()).rejects.toMatchObject({ status: 409 });
    expect(f.chain.accounts).not.toHaveBeenCalled();
    f.deposit.state = "funded";
    f.setBatch({ state: "closing", delivered_units: null });
    expect(await advance()).toMatchObject({ action: "none", pending: true, batch: { state: "closing" } });
    expect(f.chain.operatorKeyPair).not.toHaveBeenCalled();
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });

  it("only settles SQL's frozen delivered count and persists before broadcast", async () => {
    expect(await advance()).toMatchObject({ action: "settle", pending: true });
    const store = f.rpc.mock.calls.find(([name]) => name === "store_generation_escrow_transaction")!;
    expect(store[1]).toMatchObject({ p_intent_id: ID, p_owner_wallet: USER, p_kind: "settle", p_chain_now_seconds: 1100 });
    expect(store[1]).not.toHaveProperty("p_delivered_units");
    expect(f.events.indexOf("store_generation_escrow_transaction")).toBeLessThan(f.events.indexOf("broadcast"));
    const wire = vi.mocked(f.chain.broadcast).mock.calls[0][0];
    const { message } = decode(wire);
    expect(message.instructions).toHaveLength(2);
    expect(message.staticAccounts[message.instructions[1].programAddressIndex]).toBe(PROGRAM);
    expect([...message.instructions[1].data!.slice(0, 8)]).toEqual([...SETTLE_DISCRIMINATOR]);
    expect(message.instructions[1].data![8]).toBe(2);
    expect(f.getAttempt()?.signed_transaction).toBe(bytea(wire));
    for (const [addresses] of vi.mocked(f.chain.accounts).mock.calls) {
      expect(addresses.every(account => [f.derived.config, f.derived.escrow, f.derived.vault].includes(account))).toBe(true);
    }
    expect(rpcNames()).not.toContain("confirm_generation_escrow_transaction");
  });

  it("refuses a frozen count that differs from the durable unit ledger", async () => {
    f.setDeliveredCount(3);
    await expect(advance()).rejects.toMatchObject({ reason: "delivered_count_mismatch" });
    expect(f.chain.operatorKeyPair).not.toHaveBeenCalled();
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });

  it("does not broadcast if persistence fails", async () => {
    const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (name, args) => name === "store_generation_escrow_transaction"
      ? { data: null, error: { code: "XX000" } } : original(name, args));
    await expect(advance()).rejects.toMatchObject({ status: 503 });
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });

  it("a racing builder sends the stored winning wire instead of its newly built transaction", async () => {
    const winner = await f.makeAttempt("settle", { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: BigInt(1900) });
    f.setWinningAttempt(winner);
    expect(await advance()).toMatchObject({ action: "settle", pending: true });
    const built = f.rpc.mock.calls.find(([name]) => name === "store_generation_escrow_transaction")![1].p_signed_transaction;
    expect(built).not.toBe(winner.signed_transaction);
    expect(f.chain.broadcast).toHaveBeenCalledExactlyOnceWith(Buffer.from(winner.signed_transaction.slice(2), "hex").toString("base64"));
  });

  it("a retry resends the immutable persisted wire without rebuilding or obtaining the key", async () => {
    const attempt = await f.makeAttempt();
    f.setAttempt(attempt);
    expect(await advance()).toMatchObject({ action: "settle", pending: true });
    expect(await advance()).toMatchObject({ action: "settle", pending: true });
    const wire = Buffer.from(attempt.signed_transaction.slice(2), "hex").toString("base64");
    expect(f.chain.broadcast).toHaveBeenNthCalledWith(1, wire);
    expect(f.chain.broadcast).toHaveBeenNthCalledWith(2, wire);
    expect(f.chain.operatorKeyPair).not.toHaveBeenCalled();
    expect(f.chain.lifetime).not.toHaveBeenCalled();
    expect(rpcNames()).not.toContain("store_generation_escrow_transaction");
  });

  it("ambiguous broadcast failure keeps the submitted wire retryable", async () => {
    vi.mocked(f.chain.broadcast).mockRejectedValue(new EscrowPaymentError(503, "Network unavailable"));
    expect(await advance()).toMatchObject({ action: "settle", pending: true });
    expect(f.getAttempt()?.state).toBe("submitted");
    expect(f.getAttempt()?.signed_transaction).toMatch(/^\\x/);
    expect(rpcNames()).not.toContain("expire_generation_escrow_transaction");
  });

  it("confirms successful settlement only with a matching canonical bank at the receipt slot", async () => {
    const attempt = await f.makeAttempt(); f.setAttempt(attempt);
    f.settledBank(); f.bank.slot = BigInt(501);
    vi.mocked(f.chain.receipt).mockResolvedValue({ slot: BigInt(500), commitment: "confirmed", failed: false });
    expect(await advance()).toMatchObject({ action: "settle", pending: false, batch: { state: "settled" } });
    expect(f.chain.accounts).toHaveBeenCalledWith([f.derived.escrow, f.derived.vault], "confirmed", BigInt(500));
    expect(f.rpc).toHaveBeenCalledWith("confirm_generation_escrow_transaction", {
      p_intent_id: ID, p_owner_wallet: USER, p_transaction_id: ATTEMPT_ID,
      p_signature: attempt.signature, p_confirmed_slot: "500",
    });
    expect(f.chain.broadcast).not.toHaveBeenCalled();
    expect(f.chain.operatorKeyPair).not.toHaveBeenCalled();
  });

  it.each(["stale", "wrong k", "vault program", "vault absent", "funded state"])(
    "does not confirm a landed signature with %s account proof", async alteration => {
      f.setAttempt(await f.makeAttempt()); f.settledBank(); f.bank.slot = BigInt(501);
      if (alteration === "stale") f.bank.slot = BigInt(499);
      if (alteration === "wrong k") f.updateEscrow({ settledUnits: 3 });
      if (alteration === "vault program") f.vault.programAddress = PROGRAM;
      if (alteration === "vault absent") f.bank.accounts[1] = null;
      if (alteration === "funded state") f.updateEscrow({ state: EscrowState.Funded });
      vi.mocked(f.chain.receipt).mockResolvedValue({ slot: BigInt(500), commitment: "finalized", failed: false });
      await expect(advance()).rejects.toMatchObject({ status: alteration === "stale" ? 503 : 409 });
      expect(rpcNames()).not.toContain("confirm_generation_escrow_transaction");
      expect(rpcNames()).not.toContain("expire_generation_escrow_transaction");
    },
  );

  it("accepts the artist-forfeited settlement without reading any artist ATA", async () => {
    f.setAttempt(await f.makeAttempt()); f.settledBank(2, true); f.bank.slot = BigInt(501);
    vi.mocked(f.chain.receipt).mockResolvedValue({ slot: BigInt(500), commitment: "confirmed", failed: false });
    expect(await advance()).toMatchObject({ batch: { state: "settled" } });
    const artistAta = await escrowTokenAddress(artist.address, escrowMint("solana-devnet"));
    expect(vi.mocked(f.chain.accounts).mock.calls.flatMap(([addresses]) => addresses)).not.toContain(artistAta);
  });

  it("uses the current operator after rotation and permits settling while admissions are paused", async () => {
    f.chain.operatorAddress = nextOperator.address;
    vi.mocked(f.chain.operatorKeyPair).mockResolvedValue(nextOperator.keyPair);
    f.updateConfig({ operator: nextOperator.address, paused: true });
    expect(await advance()).toMatchObject({ action: "settle", pending: true });
    const wire = vi.mocked(f.chain.broadcast).mock.calls[0][0];
    expect(Object.keys(decode(wire).transaction.signatures)).toEqual([nextOperator.address]);
    expect(f.deposit.rent_payer).toBe(operator.address);
  });

  it.each(["wrong operator", "forged owner", "wrong bump"])("rejects %s Config before signing", async alteration => {
    if (alteration === "wrong operator") f.updateConfig({ operator: nextOperator.address });
    if (alteration === "forged owner") f.config.programAddress = treasury.address;
    if (alteration === "wrong bump") f.updateConfig({ bump: f.derived.configBump ^ 1 });
    await expect(advance()).rejects.toMatchObject({ status: 503 });
    expect(f.chain.operatorKeyPair).not.toHaveBeenCalled();
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });
});

describe("settlement attempt expiry", () => {
  beforeEach(async () => {
    f.setAttempt(await f.makeAttempt());
    vi.mocked(f.chain.height).mockResolvedValue(BigInt(1801));
    f.bank.slot = BigInt(601);
  });

  it("expires only at the same finalized bank's height with matching still-funded accounts", async () => {
    expect(await advance()).toMatchObject({ action: "expired", pending: true });
    expect(f.chain.accounts).toHaveBeenCalledWith([f.derived.escrow, f.derived.vault], "finalized", BigInt(300));
    expect(f.chain.finalizedHeight).toHaveBeenCalledExactlyOnceWith(BigInt(601));
    expect(f.rpc).toHaveBeenCalledWith("expire_generation_escrow_transaction", {
      p_intent_id: ID, p_owner_wallet: USER, p_transaction_id: ATTEMPT_ID,
      p_finalized_block_height: "1801", p_absence_checked_slot: "601",
    });
    expect(f.chain.broadcast).not.toHaveBeenCalled();
    expect(f.chain.lifetime).not.toHaveBeenCalled();
  });

  it("does not expire when the finalized bank is still inside the blockhash lifetime", async () => {
    vi.mocked(f.chain.finalizedHeight).mockResolvedValue(BigInt(1800));
    expect(await advance()).toMatchObject({ action: "settle", pending: true });
    expect(rpcNames()).not.toContain("expire_generation_escrow_transaction");
  });

  it.each([
    { slot: BigInt(500), commitment: "processed" as const, failed: false },
    { slot: BigInt(500), commitment: "processed" as const, failed: true },
    { slot: BigInt(500), commitment: "confirmed" as const, failed: true },
    { slot: BigInt(500), commitment: null, failed: true },
  ])("does not expire on unresolved receipt $commitment/$failed", async receipt => {
    vi.mocked(f.chain.receipt).mockResolvedValue(receipt);
    expect(await advance()).toMatchObject({ action: "settle", pending: true });
    expect(f.chain.finalizedHeight).not.toHaveBeenCalled();
    expect(rpcNames()).not.toContain("expire_generation_escrow_transaction");
  });

  it("a finalized failed receipt uses its slot as the finalized snapshot lower bound", async () => {
    vi.mocked(f.chain.receipt).mockResolvedValue({ slot: BigInt(600), commitment: "finalized", failed: true });
    expect(await advance()).toMatchObject({ action: "expired" });
    expect(f.chain.accounts).toHaveBeenCalledWith([f.derived.escrow, f.derived.vault], "finalized", BigInt(600));
  });

  it("a receipt timeout is never evidence of expiry", async () => {
    vi.mocked(f.chain.receipt).mockRejectedValue(new EscrowPaymentError(503, "Network timed out"));
    await expect(advance()).rejects.toMatchObject({ status: 503 });
    expect(f.chain.finalizedHeight).not.toHaveBeenCalled();
    expect(rpcNames()).not.toContain("expire_generation_escrow_transaction");
  });

  it("a finalized bank timeout is never evidence of expiry", async () => {
    vi.mocked(f.chain.accounts).mockImplementation(async (addresses, commitment) => {
      if (commitment === "finalized") throw new EscrowPaymentError(503, "Network timed out");
      return { ...f.bank, accounts: addresses.length === 1 ? [f.config] : f.bank.accounts };
    });
    await expect(advance()).rejects.toMatchObject({ status: 503 });
    expect(rpcNames()).not.toContain("expire_generation_escrow_transaction");
  });

  it("visible settlement effects block expiry even when the receipt is absent", async () => {
    f.settledBank();
    await expect(advance()).rejects.toMatchObject({ reason: "funding_proof_mismatch" });
    expect(rpcNames()).not.toContain("expire_generation_escrow_transaction");
  });
});

describe("separate reclaim lifecycle", () => {
  it("builds reclaim on the next call after settled state, without bundling an artist ATA creation", async () => {
    f.setBatch({ state: "settled", settlement_signature: "verified-settlement" });
    f.settledBank();
    expect(await advance()).toMatchObject({ action: "reclaim", pending: true });
    expect(f.rpc.mock.calls.find(([name]) => name === "store_generation_escrow_transaction")![1]).toMatchObject({ p_kind: "reclaim" });
    const { message } = decode(vi.mocked(f.chain.broadcast).mock.calls[0][0]);
    expect(message.instructions).toHaveLength(2);
    expect([...message.instructions[1].data!]).toEqual([...RECLAIM_DISCRIMINATOR]);
    expect(message.instructions.some(instruction => message.staticAccounts[instruction.programAddressIndex] === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")).toBe(false);
  });

  it("an expired funded batch reclaims without pretending its delivered images were settled", async () => {
    f.bank.chainNowSeconds = 2800;
    expect(await advance()).toMatchObject({ action: "reclaim", pending: true });
    expect(f.chain.accounts).not.toHaveBeenCalledWith([f.derived.config], "confirmed", BigInt(300));
    expect(f.getAttempt()?.kind).toBe("reclaim");
  });

  it("confirms reclaim only with a receipt and both canonical PDAs absent at its slot", async () => {
    f.setBatch({ state: "settled", settlement_signature: "verified-settlement" });
    const attempt = await f.makeAttempt("reclaim"); f.setAttempt(attempt);
    f.bank.accounts = [null, null]; f.bank.slot = BigInt(701);
    vi.mocked(f.chain.receipt).mockResolvedValue({ slot: BigInt(700), commitment: "confirmed", failed: false });
    expect(await advance()).toMatchObject({ action: "reclaim", pending: false, batch: { state: "closed" } });
    expect(f.chain.accounts).toHaveBeenCalledWith([f.derived.escrow, f.derived.vault], "confirmed", BigInt(700));
    expect(rpcNames()).toContain("confirm_generation_escrow_transaction");
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });

  it.each(["escrow", "vault", "stale"])("does not confirm reclaim with %s still unverified", async alteration => {
    f.setBatch({ state: "settled", settlement_signature: "verified-settlement" });
    f.setAttempt(await f.makeAttempt("reclaim")); f.bank.accounts = [null, null]; f.bank.slot = BigInt(701);
    if (alteration === "escrow") f.bank.accounts[0] = f.escrow;
    if (alteration === "vault") f.bank.accounts[1] = f.vault;
    if (alteration === "stale") f.bank.slot = BigInt(699);
    vi.mocked(f.chain.receipt).mockResolvedValue({ slot: BigInt(700), commitment: "finalized", failed: false });
    await expect(advance()).rejects.toMatchObject({ status: alteration === "stale" ? 503 : 409 });
    expect(rpcNames()).not.toContain("confirm_generation_escrow_transaction");
  });

  it("does not adopt absent PDAs without a stored successful reclaim receipt", async () => {
    f.setBatch({ state: "settled", settlement_signature: "verified-settlement" });
    f.bank.accounts = [null, null];
    await expect(advance()).rejects.toMatchObject({ reason: "missing_escrow_without_receipt" });
    expect(rpcNames()).not.toContain("confirm_generation_escrow_transaction");
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });

  it("closed batches return without signing, broadcast or reconciliation", async () => {
    f.setBatch({ state: "closed", settlement_signature: "verified-settlement" });
    expect(await advance()).toMatchObject({ action: "none", pending: false, batch: { state: "closed" } });
    expect(f.chain.receipt).not.toHaveBeenCalled();
    expect(f.chain.operatorKeyPair).not.toHaveBeenCalled();
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });
});

describe("settle-to-reclaim transition", () => {
  it("stops after confirming settle and builds reclaim only on the subsequent call", async () => {
    const attempt = await f.makeAttempt(); f.setAttempt(attempt);
    f.settledBank(); f.bank.slot = BigInt(501);
    vi.mocked(f.chain.receipt).mockImplementation(async signature => signature === attempt.signature
      ? { slot: BigInt(500), commitment: "confirmed", failed: false } : null);
    expect(await advance()).toMatchObject({ action: "settle", pending: false, batch: { state: "settled" } });
    expect(f.chain.broadcast).not.toHaveBeenCalled();
    expect(f.chain.operatorKeyPair).not.toHaveBeenCalled();
    expect(await advance()).toMatchObject({ action: "reclaim", pending: true });
    expect(f.chain.broadcast).toHaveBeenCalledTimes(1);
    const { message } = decode(vi.mocked(f.chain.broadcast).mock.calls[0][0]);
    expect(message.instructions).toHaveLength(2);
    expect([...message.instructions[1].data!]).toEqual([...RECLAIM_DISCRIMINATOR]);
  });

  it("an unlanded reclaim expires only while its prior settlement remains visible in the finalized bank", async () => {
    f.setBatch({ state: "settled", settlement_signature: "verified-settlement" });
    f.settledBank(); f.bank.slot = BigInt(601); f.setAttempt(await f.makeAttempt("reclaim"));
    vi.mocked(f.chain.height).mockResolvedValue(BigInt(1801));
    expect(await advance()).toMatchObject({ action: "expired", pending: true });
    expect(f.chain.finalizedHeight).toHaveBeenCalledExactlyOnceWith(BigInt(601));
    expect(rpcNames()).toContain("expire_generation_escrow_transaction");
  });

  it("missing reclaim PDAs with no receipt are an unresolved effect, not an expired attempt", async () => {
    f.setBatch({ state: "settled", settlement_signature: "verified-settlement" });
    f.bank.accounts = [null, null]; f.bank.slot = BigInt(601); f.setAttempt(await f.makeAttempt("reclaim"));
    vi.mocked(f.chain.height).mockResolvedValue(BigInt(1801));
    await expect(advance()).rejects.toMatchObject({ reason: "missing_settlement_accounts" });
    expect(rpcNames()).not.toContain("expire_generation_escrow_transaction");
    expect(f.chain.broadcast).not.toHaveBeenCalled();
  });
});
