import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  address, blockhash, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder,
  partiallySignTransaction, verifySignature, type KeyPairSigner,
} from "@solana/kit";
import { AccountState, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { BorshInstructionCoder, BorshAccountsCoder, BN, type Idl } from "@coral-xyz/anchor";
import { PAYMENT_CHAINS } from "@/shared/payment-config";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import idl from "../escrow/idl/enki_escrow.json";
import {
  EMPTY_RECIPIENT, escrowAddresses, escrowIntentBytes, escrowMint, escrowTokenAddress,
} from "../escrow/addresses";
import { coSignEscrowDeposit, prepareEscrowDeposit, type EscrowDepositPlan } from "../escrow/deposit";
import { validateEscrowConfiguration, verifyFundedEscrow, type EscrowChainAccount } from "../escrow/confirmation";
import {
  EscrowState, getConfigEncoder, getEscrowEncoder, type ConfigInput, type EscrowInput,
} from "../escrow/generated";

const PROGRAM = address("hNNT7mTmthTVvnw4NYo6jYoBTDazRgweWTBHBmwgcak");
const INTENT = "00112233-4455-6677-8899-aabbccddeeff";
const lifetime = { blockhash: blockhash("6zRZaKfDGdKRvSaBnFVE9RarFAbn9DsWwVAKrTLbLNKZ"), lastValidBlockHeight: BigInt(1800) };
let buyer: KeyPairSigner, sponsor: KeyPairSigner, treasury: KeyPairSigner, artist: KeyPairSigner, stranger: KeyPairSigner;
beforeAll(async () => {
  // Public, deterministic test seeds, never development or production wallets.
  [buyer, sponsor, treasury, artist, stranger] = await Promise.all([1, 2, 3, 4, 5].map(
    (seed) => createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(seed)),
  ));
});
const plan = (overrides: Partial<EscrowDepositPlan> = {}): EscrowDepositPlan => ({
  programAddress: PROGRAM, cluster: "solana-devnet", intentId: INTENT,
  buyer: buyer.address, rentPayer: sponsor.address, treasuryOwner: treasury.address, artistOwner: artist.address,
  units: 4, treasuryUnitMicro: 100_000, artistUnitMicro: 150_000,
  chainNowSeconds: 1000, expiresAtSeconds: 1900, ...overrides,
});
async function buyerSigned(prepared: Awaited<ReturnType<typeof prepareEscrowDeposit>>) {
  const unsigned = getTransactionDecoder().decode(Buffer.from(prepared.unsignedTransactionBase64, "base64"));
  return partiallySignTransaction([buyer.keyPair], unsigned);
}
const wire = (transaction: Parameters<ReturnType<typeof getTransactionEncoder>["encode"]>[0]) =>
  Buffer.from(getTransactionEncoder().encode(transaction)).toString("base64");

describe("Escrow transaction preparation and buyer-first sponsorship", () => {
  it("uses the application's chain names and matches its configured mints", () => {
    expect(escrowMint("solana-devnet")).toBe(PAYMENT_CHAINS["solana-devnet"].usdc);
    expect(escrowMint("solana")).toBe(PAYMENT_CHAINS.solana.usdc);
    expect(() => escrowMint("base" as "solana")).toThrow("unsupported");
    expect(() => escrowIntentBytes("00112233-4455-6677-8899-aabbccddeezz")).toThrow("invalid");
  });
  it("matches Anchor's independent Borsh coder and requires exactly buyer and sponsor", async () => {
    const prepared = await prepareEscrowDeposit(plan(), lifetime, 50_000);
    const transaction = getTransactionDecoder().decode(Buffer.from(prepared.unsignedTransactionBase64, "base64"));
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    expect(message.version).toBe("legacy");
    if (message.version !== "legacy") throw new Error("Expected a legacy wallet transaction.");
    expect(Object.keys(transaction.signatures)).toEqual([sponsor.address, buyer.address]);
    expect(Object.values(transaction.signatures)).toEqual([null, null]);
    expect(prepared.lastValidBlockHeight).toBe("1800");
    expect(prepared.depositedMicro).toBe(1_000_000);
    expect(message.instructions).toHaveLength(3);
    expect(message.staticAccounts[message.instructions[2].programAddressIndex]).toBe(PROGRAM);
    const expected = new BorshInstructionCoder(idl as Idl).encode("deposit", {
      intent_id: [...escrowIntentBytes(INTENT)], units: 4,
      recipient_owners: [new PublicKey(treasury.address), new PublicKey(artist.address)],
      unit_amounts: [new BN(100_000), new BN(150_000)], expires_at: new BN(1900),
    });
    expect(Buffer.from(message.instructions[2].data!)).toEqual(expected);
    expect([...message.instructions[0].data!]).toEqual([2, 160, 134, 1, 0]); // CU limit 100000
    expect([...message.instructions[1].data!]).toEqual([3, 80, 195, 0, 0, 0, 0, 0, 0]); // 50000 micro-lamports
  });

  it("derives PDAs and classic ATAs identically to the independent web3 implementation", async () => {
    const derived = await escrowAddresses(PROGRAM, buyer.address, INTENT);
    const program = new PublicKey(PROGRAM);
    const [escrow, bump] = PublicKey.findProgramAddressSync([
      Buffer.from("escrow"), new PublicKey(buyer.address).toBuffer(), Buffer.from("00112233445566778899aabbccddeeff", "hex"),
    ], program);
    expect(derived.escrow).toBe(escrow.toBase58());
    expect(derived.escrowBump).toBe(bump);
    expect(derived.config).toBe(PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0].toBase58());
    expect(derived.vault).toBe(PublicKey.findProgramAddressSync([Buffer.from("vault"), escrow.toBuffer()], program)[0].toBase58());
    const mint = escrowMint("solana-devnet");
    const expectedAta = PublicKey.findProgramAddressSync([
      new PublicKey(buyer.address).toBuffer(), new PublicKey(TOKEN_PROGRAM_ADDRESS).toBuffer(), new PublicKey(mint).toBuffer(),
    ], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0];
    expect(await escrowTokenAddress(buyer.address, mint)).toBe(expectedAta.toBase58());
    expect((await escrowAddresses(stranger.address, buyer.address, INTENT)).escrow).not.toBe(derived.escrow);
  });

  it("adds a valid sponsor signature after the buyer signature and keeps the message identical", async () => {
    const prepared = await prepareEscrowDeposit(plan(), lifetime);
    const result = await coSignEscrowDeposit(prepared, wire(await buyerSigned(prepared)), sponsor.keyPair);
    const signed = getTransactionDecoder().decode(Buffer.from(result.signedTransactionBase64, "base64"));
    expect(Buffer.from(signed.messageBytes).toString("base64")).toBe(prepared.messageBase64);
    expect(await verifySignature(buyer.keyPair.publicKey, signed.signatures[buyer.address]!, signed.messageBytes)).toBe(true);
    expect(await verifySignature(sponsor.keyPair.publicKey, signed.signatures[sponsor.address]!, signed.messageBytes)).toBe(true);
    expect(result.depositSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  });

  it("never invokes sponsor signing for a missing or forged buyer signature", async () => {
    const prepared = await prepareEscrowDeposit(plan(), lifetime);
    const transaction = await buyerSigned(prepared);
    const forged = { ...transaction, signatures: { ...transaction.signatures, [buyer.address]: transaction.signatures[sponsor.address] } };
    const badBytes = new Uint8Array(transaction.signatures[buyer.address]!);
    badBytes[0] ^= 1;
    const corrupted = { ...transaction, signatures: { ...transaction.signatures, [buyer.address]: badBytes as typeof transaction.signatures[typeof buyer.address] } };
    const signing = vi.spyOn(crypto.subtle, "sign");
    try {
      await expect(coSignEscrowDeposit(prepared, wire(forged), sponsor.keyPair)).rejects.toThrow("buyer has not signed");
      await expect(coSignEscrowDeposit(prepared, wire(corrupted), sponsor.keyPair)).rejects.toThrow("buyer has not signed");
      expect(signing).not.toHaveBeenCalled();
    } finally { signing.mockRestore(); }
  });

  it.each(["amount", "recipient", "count", "expiry", "program", "blockhash"])(
    "rejects a buyer-signed substitution of %s", async (field) => {
      const original = await prepareEscrowDeposit(plan(), lifetime);
      const changes: Partial<EscrowDepositPlan> = {};
      if (field === "amount") changes.treasuryUnitMicro = 100_001;
      if (field === "recipient") changes.artistOwner = stranger.address;
      if (field === "count") changes.units = 5;
      if (field === "expiry") changes.expiresAtSeconds = 1901;
      if (field === "program") changes.programAddress = stranger.address;
      const changed = await prepareEscrowDeposit(plan(changes), field === "blockhash"
        ? { ...lifetime, blockhash: blockhash(stranger.address) } : lifetime);
      await expect(coSignEscrowDeposit(original, wire(await buyerSigned(changed)), sponsor.keyPair)).rejects.toThrow("differs");
    },
  );

  it("rejects a different sponsor key and an altered signer expectation", async () => {
    const prepared = await prepareEscrowDeposit(plan(), lifetime);
    const signed = wire(await buyerSigned(prepared));
    await expect(coSignEscrowDeposit(prepared, signed, stranger.keyPair)).rejects.toThrow("sponsor is unavailable");
    await expect(coSignEscrowDeposit({ ...prepared, buyer: stranger.address }, signed, sponsor.keyPair)).rejects.toThrow("signers are invalid");
  });

  it("rejects an extra buyer-signed instruction spending the sponsor's SOL", async () => {
    const prepared = await prepareEscrowDeposit(plan(), lifetime);
    const changed = Transaction.from(Buffer.from(prepared.unsignedTransactionBase64, "base64"));
    changed.add(SystemProgram.transfer({
      fromPubkey: new PublicKey(sponsor.address), toPubkey: new PublicKey(stranger.address), lamports: 1_000_000_000,
    }));
    const returned = getTransactionDecoder().decode(changed.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const signed = await partiallySignTransaction([buyer.keyPair], returned);
    await expect(coSignEscrowDeposit(prepared, wire(signed), sponsor.keyPair)).rejects.toThrow("differs");
  });

  it.each(["trailing", "whitespace", "oversized", "invalid-base64", "short"])("rejects %s wire input", async (kind) => {
    const prepared = await prepareEscrowDeposit(plan(), lifetime);
    const signed = wire(await buyerSigned(prepared));
    const input = kind === "trailing" ? Buffer.concat([Buffer.from(signed, "base64"), Buffer.from([0])]).toString("base64")
      : kind === "whitespace" ? `${signed}\n` : kind === "oversized" ? Buffer.alloc(1233).toString("base64")
      : kind === "short" ? "AA==" : "!!!!";
    await expect(coSignEscrowDeposit(prepared, input, sponsor.keyPair)).rejects.toThrow();
  });

  it.each([0, 25, 1.5])("rejects %s units before producing a payment", async (units) => {
    await expect(prepareEscrowDeposit(plan({ units }), lifetime)).rejects.toThrow();
  });
  it("enforces deposit caps, TTL, recipient sentinel and priority bounds", async () => {
    for (const invalid of [
      { treasuryUnitMicro: 25_000_000 }, { treasuryUnitMicro: 0, artistUnitMicro: 0, artistOwner: EMPTY_RECIPIENT },
      { expiresAtSeconds: 1599 }, { expiresAtSeconds: 2801 }, { artistUnitMicro: 0 },
      { artistOwner: EMPTY_RECIPIENT }, { treasuryOwner: EMPTY_RECIPIENT }, { rentPayer: buyer.address },
    ]) await expect(prepareEscrowDeposit(plan(invalid), lifetime)).rejects.toThrow();
    for (const priority of [-1, 50_001, 0.5]) await expect(prepareEscrowDeposit(plan(), lifetime, priority)).rejects.toThrow();
    await expect(prepareEscrowDeposit(plan(), { ...lifetime, lastValidBlockHeight: BigInt(-1) })).rejects.toThrow();
    await expect(prepareEscrowDeposit(plan({ artistUnitMicro: 0, artistOwner: EMPTY_RECIPIENT }), lifetime)).resolves.toHaveProperty("depositedMicro", 400_000);
  });
});

async function funded(overrides: Partial<EscrowInput> = {}) {
  const expected = plan();
  const derived = await escrowAddresses(PROGRAM, buyer.address, INTENT);
  const escrow: EscrowChainAccount = {
    address: derived.escrow, programAddress: PROGRAM, executable: false,
    data: getEscrowEncoder().encode({
      version: 1, state: EscrowState.Funded, bump: derived.escrowBump, vaultBump: derived.vaultBump,
      intentId: derived.intentBytes, buyer: buyer.address, mint: escrowMint(expected.cluster), rentPayer: sponsor.address,
      recipientCount: 2, recipientOwners: [treasury.address, artist.address], unitAmounts: [100_000, 150_000],
      units: 4, settledUnits: 0, createdAt: 1000, expiresAt: 1900, ...overrides,
    }),
  };
  const vault: EscrowChainAccount = {
    address: derived.vault, programAddress: TOKEN_PROGRAM_ADDRESS, executable: false,
    data: getTokenEncoder().encode({
      mint: escrowMint(expected.cluster), owner: derived.escrow, amount: 1_000_000,
      delegate: null, state: AccountState.Initialized, isNative: null, delegatedAmount: 0, closeAuthority: null,
    }),
  };
  return { commitment: "confirmed" as const, contextSlot: BigInt(101), minimumSlot: BigInt(100), chainNowSeconds: 1001, escrow, vault };
}

describe("Only the expected confirmed escrow releases generation", () => {
  it("decodes the generated account using Anchor's independent account coder", async () => {
    const receipt = await funded();
    const accountName = idl.accounts.find((account) => account.name.toLowerCase() === "escrow")!.name;
    const decoded = new BorshAccountsCoder(idl as Idl).decode(accountName, Buffer.from(receipt.escrow.data));
    expect(decoded.buyer.toBase58()).toBe(buyer.address);
    expect(decoded.rent_payer.toBase58()).toBe(sponsor.address);
    expect(decoded.unit_amounts.map((amount: BN) => amount.toNumber())).toEqual([100_000, 150_000]);
    expect(decoded.units).toBe(4);
    expect(decoded.state).toEqual({ Funded: {} });
    expect(Buffer.from(decoded.intent_id).toString("hex")).toBe("00112233445566778899aabbccddeeff");
  });
  it("accepts the exact funded account and does not increase units for donated vault tokens", async () => {
    const receipt = await funded();
    expect((await verifyFundedEscrow(plan(), receipt)).depositedMicro).toBe(1_000_000);
    const extra = Uint8Array.from(receipt.vault.data);
    extra[64] = 65; // Token amount's low byte: 1000000 -> 1000001.
    const result = await verifyFundedEscrow(plan(), { ...receipt, vault: { ...receipt.vault, data: extra } });
    expect(result.vault.amount).toBe(BigInt(1_000_001));
    expect(result.escrow.units).toBe(4);
    expect(result.depositedMicro).toBe(1_000_000);
  });

  it.each(["version", "state", "bump", "vaultBump", "intentId", "buyer", "mint", "rentPayer", "recipientCount",
    "recipientOwners", "unitAmounts", "units", "settledUnits", "expiresAt", "createdAt"] as const)(
    "rejects a mismatched %s snapshot", async (field) => {
      const changes: Partial<EscrowInput> = {};
      if (field === "state") changes.state = EscrowState.Settled;
      else if (field === "intentId") changes.intentId = new Uint8Array(16);
      else if (field === "buyer" || field === "mint" || field === "rentPayer") changes[field] = stranger.address;
      else if (field === "recipientOwners") changes.recipientOwners = [treasury.address, stranger.address];
      else if (field === "unitAmounts") changes.unitAmounts = [100_001, 150_000];
      else if (field === "expiresAt") changes.expiresAt = 1901;
      else if (field === "createdAt") changes.createdAt = 1800;
      else if (field === "bump" || field === "vaultBump") changes[field] = 0;
      else changes[field] = 255;
      await expect(verifyFundedEscrow(plan(), await funded(changes))).rejects.toThrow();
    },
  );

  it.each(["escrow-address", "escrow-owner", "vault-address", "vault-owner", "executable", "discriminator", "data-size",
    "short-vault", "vault-token-owner", "vault-mint", "vault-frozen", "vault-delegate", "vault-close-authority", "stale-slot", "missing-slot", "processed", "expired", "future-clock"])(
    "rejects %s chain proof", async (field) => {
      const receipt = await funded();
      if (field === "escrow-address") receipt.escrow.address = stranger.address;
      if (field === "escrow-owner") receipt.escrow.programAddress = stranger.address;
      if (field === "vault-address") receipt.vault.address = stranger.address;
      if (field === "vault-owner") receipt.vault.programAddress = stranger.address as typeof TOKEN_PROGRAM_ADDRESS;
      if (field === "executable") receipt.escrow.executable = true;
      if (field === "discriminator" || field === "data-size") {
        const bytes = Uint8Array.from(receipt.escrow.data); bytes[0] ^= 1;
        receipt.escrow.data = field === "data-size" ? bytes.slice(0, -1) : bytes;
      }
      if (field.startsWith("vault-") || field === "short-vault") {
        const data = Uint8Array.from(receipt.vault.data);
        if (field === "short-vault") data[64] = 63;
        if (field === "vault-token-owner") data.set(getAddressEncoder().encode(stranger.address), 32);
        if (field === "vault-mint") data.set(getAddressEncoder().encode(stranger.address), 0);
        if (field === "vault-frozen") data[108] = 2;
        if (field === "vault-delegate") { data[72] = 1; data.set(getAddressEncoder().encode(stranger.address), 76); }
        if (field === "vault-close-authority") { data[129] = 1; data.set(getAddressEncoder().encode(stranger.address), 133); }
        receipt.vault.data = data;
      }
      if (field === "stale-slot") receipt.contextSlot = BigInt(99);
      if (field === "missing-slot") receipt.minimumSlot = BigInt(0);
      if (field === "processed") receipt.commitment = "processed" as "confirmed";
      if (field === "expired") receipt.chainNowSeconds = 1900;
      if (field === "future-clock") receipt.chainNowSeconds = 999;
      await expect(verifyFundedEscrow(plan(), receipt)).rejects.toThrow();
    },
  );
});

async function configuration(overrides: Partial<ConfigInput> = {}) {
  const derived = await escrowAddresses(PROGRAM, buyer.address, INTENT);
  return {
    address: derived.config, programAddress: PROGRAM, executable: false,
    data: getConfigEncoder().encode({
      admin: sponsor.address, guardian: sponsor.address, operator: sponsor.address,
      treasuryOwner: treasury.address, paused: false, maxDepositMicro: 25_000_000,
      minTtlS: 600, maxTtlS: 1800, refundAtaFeeMicro: 1_000_000, bump: derived.configBump, ...overrides,
    }),
  };
}
describe("Current chain configuration gates new deposits", () => {
  it("accepts the matching configured treasury and bounds", async () => {
    await expect(validateEscrowConfiguration(plan(), await configuration())).resolves.toHaveProperty("treasuryOwner", treasury.address);
  });
  it.each(["paused", "revoked", "treasury", "cap", "ttl", "fee", "bump"])("rejects %s configuration", async (field) => {
    const changes: Partial<ConfigInput> = {};
    if (field === "paused") changes.paused = true;
    if (field === "revoked") changes.operator = EMPTY_RECIPIENT;
    if (field === "treasury") changes.treasuryOwner = stranger.address;
    if (field === "cap") changes.maxDepositMicro = 999_999;
    if (field === "ttl") changes.minTtlS = 901;
    if (field === "fee") changes.refundAtaFeeMicro = 1_000_001;
    if (field === "bump") changes.bump = 0;
    await expect(validateEscrowConfiguration(plan(), await configuration(changes))).rejects.toThrow();
  });
});
