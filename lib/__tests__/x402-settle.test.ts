import { describe, it, expect } from "vitest";
import {
  Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage,
  VersionedTransaction, MessageV0, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { parseXPayment, verifyAgentPayment, cosignAsFeePayer, submitAndConfirm } from "@/lib/payments/x402-settle";

/**
 * Every reject rule in verifyAgentPayment guards the fee payer's key or the
 * platform's money, so every rule gets a transaction that violates exactly
 * it. All offline — the txs are real (web3.js-built and signed), the chain
 * is never involved.
 */

const feePayer = Keypair.generate();
const client = Keypair.generate();
const mintAuthority = Keypair.generate();
const mint = mintAuthority.publicKey; // any pubkey works as a mint offline
const payTo = Keypair.generate().publicKey;
const platformAta = getAssociatedTokenAddressSync(mint, payTo);
const clientAta = getAssociatedTokenAddressSync(mint, client.publicKey);
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const AMOUNT = 269_000;

const params = { legs: [{ owner: payTo, amountMicro: AMOUNT }], mint, feePayer: feePayer.publicKey };

function transferIx(over: { amount?: number | bigint; dest?: PublicKey; mint?: PublicKey; authority?: PublicKey; source?: PublicKey; decimals?: number } = {}) {
  return createTransferCheckedInstruction(
    over.source ?? clientAta,
    over.mint ?? mint,
    over.dest ?? platformAta,
    over.authority ?? client.publicKey,
    over.amount ?? AMOUNT,
    over.decimals ?? 6,
  );
}

function buildTx(instructions: TransactionInstruction[], opts: { payer?: PublicKey; sign?: boolean } = {}) {
  const msg = new TransactionMessage({
    payerKey: opts.payer ?? feePayer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  if (opts.sign !== false) tx.sign([client]);
  return tx;
}

const budget = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
];

describe("verifyAgentPayment", () => {
  it("accepts the canonical payment: budget + exact TransferChecked, client-signed", () => {
    const r = verifyAgentPayment(buildTx([...budget(), transferIx()]), params);
    expect(r).toEqual({ ok: true, payer: client.publicKey });
  });

  it("accepts a memo riding along", () => {
    const memo = new TransactionInstruction({
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      keys: [], data: Buffer.from("nonce-1"),
    });
    expect(verifyAgentPayment(buildTx([...budget(), transferIx(), memo]), params).ok).toBe(true);
  });

  it("rejects a wrong amount — over and under", () => {
    for (const amount of [AMOUNT - 1, AMOUNT + 1]) {
      const r = verifyAgentPayment(buildTx([transferIx({ amount })]), params);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("extra.legs");
    }
  });

  it("rejects a foreign mint", () => {
    const other = Keypair.generate().publicKey;
    const r = verifyAgentPayment(
      buildTx([transferIx({ mint: other, source: getAssociatedTokenAddressSync(other, client.publicKey), dest: getAssociatedTokenAddressSync(other, payTo) })]),
      params,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("USDC");
  });

  it("rejects a redirected destination", () => {
    const elsewhere = getAssociatedTokenAddressSync(mint, Keypair.generate().publicKey);
    const r = verifyAgentPayment(buildTx([transferIx({ dest: elsewhere })]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("extra.legs");
  });

  it("rejects wrong decimals", () => {
    const r = verifyAgentPayment(buildTx([transferIx({ decimals: 5 })]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("decimals");
  });

  it("rejects any unknown program — a system transfer smuggled in", () => {
    const smuggle = SystemProgram.transfer({ fromPubkey: client.publicKey, toPubkey: payTo, lamports: 1 });
    const r = verifyAgentPayment(buildTx([transferIx(), smuggle]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not accepted");
  });

  it("rejects a transfer beyond the required legs", () => {
    const r = verifyAgentPayment(buildTx([transferIx(), transferIx()]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("extra.legs");
  });

  it("rejects the fee payer as transfer authority — its funds, our signature", () => {
    const tx = buildTx(
      [transferIx({ authority: feePayer.publicKey, source: getAssociatedTokenAddressSync(mint, feePayer.publicKey) })],
      { sign: false },
    );
    const r = verifyAgentPayment(tx, params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("fee payer");
  });

  it("rejects the fee payer appearing in any instruction account", () => {
    const memoTouching = new TransactionInstruction({
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      keys: [{ pubkey: feePayer.publicKey, isSigner: false, isWritable: false }],
      data: Buffer.from("x"),
    });
    const r = verifyAgentPayment(buildTx([transferIx(), memoTouching]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("fee payer");
  });

  it("rejects a wrong fee payer at account 0", () => {
    const r = verifyAgentPayment(buildTx([transferIx()], { payer: client.publicKey }), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("fee payer");
  });

  it("rejects a compute unit price above the facilitator ceiling", () => {
    const greedy = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_001 });
    const r = verifyAgentPayment(buildTx([greedy, transferIx()]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ceiling");
  });

  it("rejects an unsigned client — signature slot still zeroed", () => {
    const r = verifyAgentPayment(buildTx([transferIx()], { sign: false }), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("signed");
  });

  it("rejects address table lookups — accounts must be static", () => {
    const base = buildTx([transferIx()]).message as MessageV0;
    const withAlt = new VersionedTransaction(new MessageV0({
      header: base.header,
      staticAccountKeys: base.staticAccountKeys,
      recentBlockhash: base.recentBlockhash,
      compiledInstructions: base.compiledInstructions,
      addressTableLookups: [{ accountKey: Keypair.generate().publicKey, writableIndexes: [0], readonlyIndexes: [] }],
    }));
    const r = verifyAgentPayment(withAlt, params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("table");
  });
});

describe("verifyAgentPayment — artist source-split (two legs)", () => {
  const artist = Keypair.generate().publicKey;
  const artistAta = getAssociatedTokenAddressSync(mint, artist);
  const ARTIST_MICRO = 500_000;
  const PLATFORM_MICRO = 190_000;
  const twoLegs = {
    legs: [
      { owner: artist, amountMicro: ARTIST_MICRO },
      { owner: payTo, amountMicro: PLATFORM_MICRO },
    ],
    mint,
    feePayer: feePayer.publicKey,
  };
  const artistIx = () => transferIx({ dest: artistAta, amount: ARTIST_MICRO });
  const platformIx = () => transferIx({ amount: PLATFORM_MICRO });

  it("accepts artist + platform transfers in one transaction, either order", () => {
    expect(verifyAgentPayment(buildTx([...budget(), artistIx(), platformIx()]), twoLegs).ok).toBe(true);
    expect(verifyAgentPayment(buildTx([...budget(), platformIx(), artistIx()]), twoLegs).ok).toBe(true);
  });

  it("rejects a payment missing the artist leg — the platform may not hold artist money", () => {
    const r = verifyAgentPayment(buildTx([platformIx()]), twoLegs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Missing transfer");
  });

  it("rejects a short-changed artist leg", () => {
    const r = verifyAgentPayment(
      buildTx([transferIx({ dest: artistAta, amount: ARTIST_MICRO - 1 }), platformIx()]),
      twoLegs,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects two different authorities — one buyer pays every leg", () => {
    const other = Keypair.generate();
    const otherAta = getAssociatedTokenAddressSync(mint, other.publicKey);
    const tx = buildTx([
      artistIx(),
      transferIx({ amount: PLATFORM_MICRO, authority: other.publicKey, source: otherAta }),
    ], { sign: false });
    const r = verifyAgentPayment(tx, twoLegs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("one authority");
  });
});

describe("parseXPayment", () => {
  const wrap = (envelope: unknown) => Buffer.from(JSON.stringify(envelope)).toString("base64");

  it("round-trips a v0 transaction", () => {
    const tx = buildTx([transferIx()]);
    const header = wrap({ x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: Buffer.from(tx.serialize()).toString("base64") } });
    const r = parseXPayment(header);
    expect(r.ok).toBe(true);
    if (r.ok) expect(verifyAgentPayment(r.tx, params).ok).toBe(true);
  });

  it("accepts a LEGACY transaction wire format", () => {
    const legacy = new Transaction({ feePayer: feePayer.publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1 }).add(transferIx());
    legacy.partialSign(client);
    const header = wrap({ x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: legacy.serialize({ requireAllSignatures: false }).toString("base64") } });
    const r = parseXPayment(header);
    expect(r.ok).toBe(true);
    if (r.ok) expect(verifyAgentPayment(r.tx, params).ok).toBe(true);
  });

  it("rejects garbage, wrong scheme, wrong network, missing payload", () => {
    expect(parseXPayment("not-base64-json!!").ok).toBe(false);
    expect(parseXPayment(wrap({ scheme: "upto", network: "solana", payload: { transaction: "AA==" } })).ok).toBe(false);
    expect(parseXPayment(wrap({ scheme: "exact", network: "base", payload: { transaction: "AA==" } })).ok).toBe(false);
    expect(parseXPayment(wrap({ scheme: "exact", network: "solana", payload: {} })).ok).toBe(false);
  });
});

describe("cosignAsFeePayer", () => {
  it("is deterministic — the replay guard's premise: same tx, same signature", () => {
    const mk = () => {
      const tx = buildTx([...budget(), transferIx()]);
      return cosignAsFeePayer(tx, feePayer);
    };
    expect(mk()).toBe(mk());
  });
});

describe("submitAndConfirm", () => {
  const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
  const tx = { serialize: () => new Uint8Array([1, 2, 3]) };
  const conn = (statuses: () => Promise<unknown>) =>
    ({ sendRawTransaction: async () => SIG, getSignatureStatuses: statuses }) as unknown as Connection;

  it("confirms once the status says so", async () => {
    const c = conn(async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }));
    expect(await submitAndConfirm(c, tx, 5_000)).toEqual({ ok: true, signature: SIG });
  });

  it("keeps the signature when the status read fails after the broadcast", async () => {
    const c = conn(async () => { throw new Error("429 Too Many Requests"); });
    const outcome = await submitAndConfirm(c, tx, 5_000);
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ signature: SIG, error: expect.stringMatching(/429/) });
  });

  it("has no signature when the send itself is refused", async () => {
    const c = { sendRawTransaction: async () => { throw new Error("Blockhash not found"); } } as unknown as Connection;
    const outcome = await submitAndConfirm(c, tx, 5_000);
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/Blockhash/) });
    expect("signature" in outcome && outcome.signature).toBeFalsy();
  });
});
