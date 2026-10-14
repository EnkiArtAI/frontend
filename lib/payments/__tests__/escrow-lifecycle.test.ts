import { beforeAll, describe, expect, it } from "vitest";
import {
  address, blockhash, createKeyPairSignerFromPrivateKeyBytes,
  getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, verifySignature,
  type KeyPairSigner,
} from "@solana/kit";
import { AccountState, getTokenEncoder, TOKEN_PROGRAM_ADDRESS, type TokenArgs } from "@solana-program/token";
import { BorshAccountsCoder, BorshInstructionCoder, BN, type Idl } from "@coral-xyz/anchor";
import { Transaction } from "@solana/web3.js";
import idl from "../escrow/idl/enki_escrow.json";
import { EMPTY_RECIPIENT, escrowAddresses, escrowMint, escrowTokenAddress } from "../escrow/addresses";
import type { EscrowPaymentSnapshot } from "../escrow/deposit";
import type { EscrowChainAccount } from "../escrow/confirmation";
import { EscrowState, getEscrowEncoder, type EscrowInput } from "../escrow/generated";
import {
  readEscrowSnapshot, verifySettledEscrow, prepareEscrowSettlement, prepareEscrowReclaim,
} from "../escrow/lifecycle";

const PROGRAM = address("hNNT7mTmthTVvnw4NYo6jYoBTDazRgweWTBHBmwgcak");
const INTENT = "00112233-4455-6677-8899-aabbccddeeff";
const lifetime = {
  blockhash: blockhash("6zRZaKfDGdKRvSaBnFVE9RarFAbn9DsWwVAKrTLbLNKZ"),
  lastValidBlockHeight: BigInt(1800),
};
let buyer: KeyPairSigner, originalOperator: KeyPairSigner, currentOperator: KeyPairSigner;
let treasury: KeyPairSigner, artist: KeyPairSigner, stranger: KeyPairSigner;
beforeAll(async () => {
  // Public deterministic fixtures, independent of all configured real wallets.
  [buyer, originalOperator, currentOperator, treasury, artist, stranger] = await Promise.all(
    [11, 12, 13, 14, 15, 16].map((seed) =>
      createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(seed))),
  );
});
const plan = (overrides: Partial<EscrowPaymentSnapshot> = {}): EscrowPaymentSnapshot => ({
  programAddress: PROGRAM, cluster: "solana-devnet", intentId: INTENT,
  buyer: buyer.address, rentPayer: originalOperator.address,
  treasuryOwner: treasury.address, artistOwner: artist.address,
  units: 4, treasuryUnitMicro: 100_000, artistUnitMicro: 150_000,
  chainNowSeconds: 1000, expiresAtSeconds: 1900, ...overrides,
});

async function settled(options: {
  snapshot?: EscrowPaymentSnapshot; k?: number; forfeited?: boolean; dust?: bigint;
  escrow?: Partial<EscrowInput>; vault?: Partial<TokenArgs>;
} = {}) {
  const snapshot = options.snapshot ?? plan();
  const derived = await escrowAddresses(snapshot.programAddress, snapshot.buyer, snapshot.intentId);
  const k = options.k ?? 2;
  const total = BigInt(snapshot.units) * BigInt(snapshot.treasuryUnitMicro + snapshot.artistUnitMicro);
  const refundDue = total - BigInt(k) * BigInt(snapshot.treasuryUnitMicro) -
    (options.forfeited ? BigInt(0) : BigInt(k) * BigInt(snapshot.artistUnitMicro));
  const value: EscrowInput = {
    version: 1, state: EscrowState.Settled, bump: derived.escrowBump, vaultBump: derived.vaultBump,
    intentId: derived.intentBytes, buyer: snapshot.buyer, mint: escrowMint(snapshot.cluster),
    rentPayer: snapshot.rentPayer, recipientCount: snapshot.artistUnitMicro > 0 ? 2 : 1,
    recipientOwners: [snapshot.treasuryOwner, snapshot.artistOwner],
    unitAmounts: [snapshot.treasuryUnitMicro, snapshot.artistUnitMicro],
    units: snapshot.units, settledUnits: k, createdAt: 1000,
    expiresAt: snapshot.expiresAtSeconds, refundDue, ...options.escrow,
  };
  const escrow: EscrowChainAccount = {
    address: derived.escrow, programAddress: snapshot.programAddress,
    executable: false, data: getEscrowEncoder().encode(value),
  };
  const vault: EscrowChainAccount = {
    address: derived.vault, programAddress: TOKEN_PROGRAM_ADDRESS, executable: false,
    data: getTokenEncoder().encode({
      mint: escrowMint(snapshot.cluster), owner: derived.escrow, amount: refundDue + (options.dust ?? BigInt(0)),
      delegate: null, state: AccountState.Initialized, isNative: null, delegatedAmount: 0,
      closeAuthority: null, ...options.vault,
    }),
  };
  return { contextSlot: BigInt(101), minimumSlot: BigInt(100), escrow, vault };
}

function wire(result: Awaited<ReturnType<typeof prepareEscrowSettlement>>) {
  const bytes = Buffer.from(result.signedTransactionBase64, "base64");
  const transaction = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== "legacy") throw new Error("Expected a legacy lifecycle wire.");
  return { bytes, transaction, message, legacy: Transaction.from(bytes) };
}

describe("Escrow settlement proofs bind the persisted quote and delivered images", () => {
  it("agrees with Anchor's independent decoder, including the 231-byte refund claim", async () => {
    const proof = await settled();
    const name = idl.accounts.find((account) => account.name.toLowerCase() === "escrow")!.name;
    const decoded = new BorshAccountsCoder(idl as Idl).decode(name, Buffer.from(proof.escrow.data));
    expect(decoded.state).toEqual({ Settled: {} });
    expect(decoded.buyer.toBase58()).toBe(buyer.address);
    expect(decoded.rent_payer.toBase58()).toBe(originalOperator.address);
    expect(decoded.settled_units).toBe(2);
    expect(decoded.refund_due.eq(new BN(500_000))).toBe(true);
    expect(proof.escrow.data).toHaveLength(231);
    expect(await verifySettledEscrow(plan(), 2, proof)).toMatchObject({
      treasuryPaid: BigInt(200_000), artistPaid: BigInt(300_000), refundDue: BigInt(500_000),
    });
  });

  it.each([0, 1, 2, 4])("accepts exactly %s delivered images with either complete or forfeited artist payout", async (k) => {
    for (const forfeited of [false, true]) {
      const result = await verifySettledEscrow(plan(), k, await settled({ k, forfeited, dust: BigInt(1) }));
      expect(result.treasuryPaid).toBe(BigInt(k * 100_000));
      expect(result.artistPaid).toBe(BigInt(forfeited ? 0 : k * 150_000));
      expect(result.refundDue).toBe(BigInt(1_000_000) - result.treasuryPaid - result.artistPaid);
    }
  });

  it("keeps a dust donation separate from a fully paid buyer refund claim", async () => {
    const result = await verifySettledEscrow(plan(), 4, await settled({ k: 4, dust: BigInt(1) }));
    expect(result.refundDue).toBe(BigInt(0));
    expect(result.artistPaid).toBe(BigInt(600_000));
  });

  it("accepts a treasury-only quote and an expired settled account independently of today's Config", async () => {
    const snapshot = plan({ artistOwner: EMPTY_RECIPIENT, artistUnitMicro: 0 });
    await expect(verifySettledEscrow(snapshot, 2, await settled({ snapshot }))).resolves.toMatchObject({
      treasuryPaid: BigInt(200_000), artistPaid: BigInt(0), refundDue: BigInt(200_000),
    });
  });

  it.each([499_999, 500_001, 650_000, 799_999, 800_001, 1_000_000])(
    "rejects refund_due %s, including a partial artist payout or missing treasury payout", async (refundDue) => {
      await expect(verifySettledEscrow(plan(), 2, await settled({
        escrow: { refundDue }, vault: { amount: 2_000_000 },
      }))).rejects.toThrow("differs from the delivered images");
    },
  );

  it.each([-1, 1.5, 5, Number.NaN])("rejects an invalid delivered count %s", async (k) => {
    await expect(verifySettledEscrow(plan(), k, await settled())).rejects.toThrow("proof is invalid");
  });
  it("rejects a mismatched persisted delivered count", async () => {
    // Keep refund arithmetic valid for k=2, so the settled_units binding must reject this.
    await expect(verifySettledEscrow(plan(), 2, await settled({ escrow: { settledUnits: 1 } })))
      .rejects.toThrow("delivered images");
  });
  it("rejects an unconfirmed or stale account bank", async () => {
    const proof = await settled();
    await expect(verifySettledEscrow(plan(), 2, { ...proof, minimumSlot: BigInt(0) })).rejects.toThrow("proof is invalid");
    await expect(verifySettledEscrow(plan(), 2, { ...proof, contextSlot: BigInt(99) })).rejects.toThrow("proof is invalid");
  });

  it.each([
    "version", "bump", "vaultBump", "intentId", "buyer", "rentPayer", "mint",
    "units", "recipientCount", "treasuryOwner", "artistOwner", "treasuryAmount", "artistAmount",
    "expiry", "negativeCreatedAt", "shortLifetime", "longLifetime",
  ])("rejects a settled identity substitution: %s", async (field) => {
    const derived = await escrowAddresses(PROGRAM, buyer.address, INTENT);
    const substitutions: Record<string, Partial<EscrowInput>> = {
      version: { version: 2 }, bump: { bump: derived.escrowBump ^ 1 }, vaultBump: { vaultBump: derived.vaultBump ^ 1 },
      intentId: { intentId: new Uint8Array(16) }, buyer: { buyer: stranger.address },
      rentPayer: { rentPayer: currentOperator.address }, mint: { mint: escrowMint("solana") },
      units: { units: 3 }, recipientCount: { recipientCount: 1 },
      treasuryOwner: { recipientOwners: [stranger.address, artist.address] },
      artistOwner: { recipientOwners: [treasury.address, stranger.address] },
      treasuryAmount: { unitAmounts: [100_001, 150_000] }, artistAmount: { unitAmounts: [100_000, 150_001] },
      expiry: { expiresAt: 1901 }, negativeCreatedAt: { createdAt: -1 },
      shortLifetime: { createdAt: 1301 }, longLifetime: { createdAt: 99 },
    };
    await expect(verifySettledEscrow(plan(), 2, await settled({ escrow: substitutions[field] })))
      .rejects.toThrow("differs from its quote");
  });

  it("allows identity reads of funded accounts but never accepts them as settled", async () => {
    const proof = await settled({ escrow: { state: EscrowState.Funded, settledUnits: 0, refundDue: 1_000_000 },
      vault: { amount: 1_000_000 } });
    await expect(readEscrowSnapshot(plan(), proof.escrow)).resolves.toHaveProperty("state", EscrowState.Funded);
    await expect(verifySettledEscrow(plan(), 2, proof)).rejects.toThrow("delivered images");
  });

  it.each(["address", "owner", "executable", "oldLayout", "trailingBytes", "discriminator"])(
    "rejects an untrusted escrow account: %s", async (field) => {
      const proof = await settled();
      if (field === "address") proof.escrow.address = stranger.address;
      if (field === "owner") proof.escrow.programAddress = stranger.address;
      if (field === "executable") proof.escrow.executable = true;
      if (field === "oldLayout") proof.escrow.data = proof.escrow.data.slice(0, 223);
      if (field === "trailingBytes") proof.escrow.data = Buffer.concat([Buffer.from(proof.escrow.data), Buffer.from([0])]);
      if (field === "discriminator") {
        const data = Uint8Array.from(proof.escrow.data); data[0] ^= 1; proof.escrow.data = data;
      }
      await expect(verifySettledEscrow(plan(), 2, proof)).rejects.toThrow();
    },
  );
  it.each(["address", "programOwner", "executable", "shortLayout", "trailingBytes"])(
    "rejects an untrusted vault account: %s", async (field) => {
      const proof = await settled();
      if (field === "address") proof.vault.address = stranger.address;
      if (field === "programOwner") proof.vault.programAddress = stranger.address;
      if (field === "executable") proof.vault.executable = true;
      if (field === "shortLayout") proof.vault.data = proof.vault.data.slice(0, 164);
      if (field === "trailingBytes") proof.vault.data = Buffer.concat([Buffer.from(proof.vault.data), Buffer.from([0])]);
      await expect(verifySettledEscrow(plan(), 2, proof)).rejects.toThrow("vault is invalid");
    },
  );
  it.each(["authority", "mint", "frozen", "uninitialized", "insufficient", "delegate", "closeAuthority", "native"])(
    "rejects a dangerous settled vault: %s", async (field) => {
      const substitutions: Record<string, Partial<TokenArgs>> = {
        authority: { owner: stranger.address }, mint: { mint: escrowMint("solana") },
        frozen: { state: AccountState.Frozen }, uninitialized: { state: AccountState.Uninitialized },
        insufficient: { amount: 499_999 }, delegate: { delegate: stranger.address, delegatedAmount: 1 },
        closeAuthority: { closeAuthority: stranger.address }, native: { isNative: 1 },
      };
      await expect(verifySettledEscrow(plan(), 2, await settled({ vault: substitutions[field] })))
        .rejects.toThrow("delivered images");
    },
  );
});

describe("Escrow lifecycle wires remain separate and use real signatures", () => {
  it("builds only compute budget and settle, with current operator after operator rotation", async () => {
    const result = await prepareEscrowSettlement(plan(), 2, currentOperator.keyPair, lifetime);
    const { transaction, message, legacy } = wire(result);
    const derived = await escrowAddresses(PROGRAM, buyer.address, INTENT);
    expect(message.version).toBe("legacy");
    expect(Object.keys(transaction.signatures)).toEqual([currentOperator.address]);
    expect(await verifySignature(currentOperator.keyPair.publicKey,
      transaction.signatures[currentOperator.address]!, transaction.messageBytes)).toBe(true);
    expect(legacy.verifySignatures()).toBe(true);
    expect(legacy.feePayer?.toBase58()).toBe(currentOperator.address);
    expect(result.blockhash).toBe(lifetime.blockhash);
    expect(result.lastValidBlockHeight).toBe("1800");
    expect(result.signature).toBe(getBase58Decoder().decode(legacy.signature!));
    expect(message.instructions).toHaveLength(2);
    expect([...message.instructions[0].data!]).toEqual([2, 192, 212, 1, 0]); // 120000 compute units
    const settle = legacy.instructions[1];
    expect(settle.programId.toBase58()).toBe(PROGRAM);
    expect(settle.data).toEqual(new BorshInstructionCoder(idl as Idl).encode("settle", { k: 2 }));
    expect(settle.keys.map((key) => key.pubkey.toBase58())).toEqual([
      derived.config, currentOperator.address, derived.escrow, derived.vault, escrowMint("solana-devnet"),
      await escrowTokenAddress(treasury.address, escrowMint("solana-devnet")),
      await escrowTokenAddress(artist.address, escrowMint("solana-devnet")), TOKEN_PROGRAM_ADDRESS,
    ]);
    expect(settle.keys.map((key) => [key.isSigner, key.isWritable])).toEqual([
      [false, false], [true, true], [false, true], [false, true],
      [false, false], [false, true], [false, true], [false, false],
    ]);
    expect(settle.keys.some((key) => key.pubkey.toBase58() === originalOperator.address)).toBe(false);
  });

  it("always supplies the canonical artist ATA, including the empty-owner treasury-only quote", async () => {
    const snapshot = plan({ artistOwner: EMPTY_RECIPIENT, artistUnitMicro: 0 });
    const { legacy } = wire(await prepareEscrowSettlement(snapshot, 4, currentOperator.keyPair, lifetime));
    const artistAta = legacy.instructions[1].keys[6].pubkey.toBase58();
    expect(artistAta).toBe(await escrowTokenAddress(EMPTY_RECIPIENT, escrowMint(snapshot.cluster)));
    expect(artistAta).not.toBe(EMPTY_RECIPIENT);
    expect(legacy.instructions).toHaveLength(2);
  });

  it.each([0, 4])("encodes settlement count %s without consulting an artist account", async (k) => {
    const { legacy } = wire(await prepareEscrowSettlement(plan(), k, currentOperator.keyPair, lifetime));
    expect(legacy.instructions[1].data).toEqual(new BorshInstructionCoder(idl as Idl).encode("settle", { k }));
  });
  it.each([-1, 1.5, 5, Number.NaN])("rejects settlement count %s before producing a signed wire", async (k) => {
    await expect(prepareEscrowSettlement(plan(), k, currentOperator.keyPair, lifetime)).rejects.toThrow("count is invalid");
  });

  it("builds reclaim separately and merges caller and original rent payer signature when equal", async () => {
    const result = await prepareEscrowReclaim(plan(), originalOperator.keyPair, lifetime);
    const { transaction, legacy } = wire(result);
    const derived = await escrowAddresses(PROGRAM, buyer.address, INTENT);
    expect(legacy.verifySignatures()).toBe(true);
    expect(Object.keys(transaction.signatures)).toEqual([originalOperator.address]);
    expect(legacy.instructions).toHaveLength(2);
    const reclaim = legacy.instructions[1];
    expect(reclaim.data).toEqual(new BorshInstructionCoder(idl as Idl).encode("reclaim", {}));
    expect(reclaim.programId.toBase58()).toBe(PROGRAM);
    expect(reclaim.keys.map((key) => key.pubkey.toBase58())).toEqual([
      originalOperator.address, derived.config, originalOperator.address, buyer.address,
      derived.escrow, derived.vault, escrowMint("solana-devnet"),
      await escrowTokenAddress(buyer.address, escrowMint("solana-devnet")),
      await escrowTokenAddress(treasury.address, escrowMint("solana-devnet")),
      TOKEN_PROGRAM_ADDRESS, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", EMPTY_RECIPIENT,
    ]);
    expect(reclaim.keys[2]).toMatchObject({ isSigner: true, isWritable: true });
    expect(reclaim.keys[3]).toMatchObject({ isSigner: false, isWritable: false });
  });

  it("keeps the original rent destination after operator rotation without silently claiming its signature", async () => {
    const { transaction, legacy } = wire(await prepareEscrowReclaim(plan(), currentOperator.keyPair, lifetime));
    expect(Object.keys(transaction.signatures)).toEqual([currentOperator.address]);
    expect(legacy.verifySignatures()).toBe(true);
    expect(legacy.instructions[1].keys[2].pubkey.toBase58()).toBe(originalOperator.address);
    expect(legacy.instructions[1].keys[2]).toMatchObject({ isSigner: false, isWritable: true });
    // Existing buyer ATA / zero refund can close; a missing refund ATA needs this original signer.
  });

  it("derives each lifecycle wire from the selected cluster's mint", async () => {
    const snapshot = plan({ cluster: "solana" });
    const settle = wire(await prepareEscrowSettlement(snapshot, 2, currentOperator.keyPair, lifetime)).legacy;
    const reclaim = wire(await prepareEscrowReclaim(snapshot, originalOperator.keyPair, lifetime)).legacy;
    expect(settle.instructions[1].keys[4].pubkey.toBase58()).toBe(escrowMint("solana"));
    expect(reclaim.instructions[1].keys[6].pubkey.toBase58()).toBe(escrowMint("solana"));
  });

  it("rejects an invalid blockhash lifetime for both lifecycle transactions", async () => {
    const expired = { ...lifetime, lastValidBlockHeight: BigInt(-1) };
    await expect(prepareEscrowSettlement(plan(), 2, currentOperator.keyPair, expired)).rejects.toThrow("lifetime is invalid");
    await expect(prepareEscrowReclaim(plan(), currentOperator.keyPair, expired)).rejects.toThrow("lifetime is invalid");
  });
});
