import { describe, it, expect, vi, type Mock } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import type { Adapter } from "@solana/wallet-adapter-base";

/**
 * The intent rail signs with the wallet the payment is FOR. Before this, the
 * checkout called CDP unconditionally, so every external-wallet buyer
 * (Phantom, Solflare: all 16 live wallets on 2026-10-02) could not pay.
 * The transactions here are real web3.js transactions, partial-signed by a
 * fee payer exactly as lib/payments/authorize-tx.ts does it.
 */

const cdpSign = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cdp-bridge", () => ({ requestCdpSign: cdpSign, getCdpSolanaAddress: () => null }));

import { buyerOf, signForBuyer } from "@/hooks/usePaymentSigner";
import { CheckoutError } from "@/lib/generation-checkout";

const feePayer = Keypair.generate();
const buyer = Keypair.generate();
const stranger = Keypair.generate();

function authorization(): string {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: stranger.publicKey, lamports: 1 }),
  );
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.feePayer = feePayer.publicKey;
  tx.partialSign(feePayer);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

/**
 * A wallet-adapter stand-in holding `key`, disconnected like after a reload.
 * It behaves like the Wallet Standard adapter every detected wallet gets
 * (Phantom, Solflare, Backpack): signTransaction is on the adapter only while
 * an account is connected (@solana/wallet-standard-wallet-adapter-base, #reset).
 * `signs: false` is a wallet that cannot sign transactions at all.
 */
function wallet(key: Keypair, { signs = true } = {}) {
  const sign = vi.fn(async (tx: Transaction) => {
    tx.partialSign(key);
    return tx;
  });
  const w: {
    connected: boolean; publicKey: Keypair["publicKey"] | null; sign: typeof sign;
    connect: Mock<() => Promise<void>>; signTransaction?: typeof sign;
  } = {
    connected: false,
    publicKey: null,
    sign,
    connect: vi.fn(async () => {
      w.connected = true;
      w.publicKey = key.publicKey;
      if (signs) w.signTransaction = sign;
    }),
  };
  return w;
}
const asAdapter = (w: ReturnType<typeof wallet>) => w as unknown as Adapter;

/** The escrow deposit as /api/payments/generation/authorize returns it: the
 *  operator is the fee payer and has NOT signed yet (it co-signs on submit). */
function escrowDeposit(): string {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: stranger.publicKey, lamports: 1 }),
  );
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.feePayer = feePayer.publicKey;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

describe("buyerOf", () => {
  it("names the one signer the fee payer left unsigned", () => {
    expect(buyerOf(authorization())).toBe(buyer.publicKey.toBase58());
  });

  it("skips the unsigned fee payer of an escrow deposit (found on devnet 2026-10-13)", () => {
    // Both slots empty, fee payer first: the old rule named the operator and
    // every browser wallet refused with "this payment is for the wallet you signed in with".
    expect(buyerOf(escrowDeposit())).toBe(buyer.publicKey.toBase58());
  });

  it("signs the escrow deposit with the buyer's external wallet", async () => {
    const phantom = wallet(buyer);
    const signed = await signForBuyer(escrowDeposit(), { adapter: asAdapter(phantom), cdpAddress: null });
    const tx = Transaction.from(Buffer.from(signed, "base64"));
    expect(tx.signatures.find((s) => s.publicKey.equals(buyer.publicKey))?.signature).not.toBeNull();
    expect(tx.signatures.find((s) => s.publicKey.equals(feePayer.publicKey))?.signature).toBeNull();
  });
});

describe("signForBuyer", () => {
  it("an external wallet holding the buyer key connects and signs, CDP is never asked", async () => {
    cdpSign.mockReset();
    const phantom = wallet(buyer);
    const signed = await signForBuyer(authorization(), { adapter: asAdapter(phantom), cdpAddress: null });
    expect(phantom.connect).toHaveBeenCalledTimes(1);
    expect(cdpSign).not.toHaveBeenCalled();
    // Fee payer's signature survived and the buyer's is valid over the message.
    expect(Transaction.from(Buffer.from(signed, "base64")).verifySignatures()).toBe(true);
  });

  it("an embedded buyer signs through CDP even while a foreign Phantom is connected", async () => {
    cdpSign.mockReset();
    cdpSign.mockResolvedValue("signed-by-cdp");
    const phantom = wallet(stranger);
    const tx = authorization();
    expect(await signForBuyer(tx, { adapter: asAdapter(phantom), cdpAddress: buyer.publicKey.toBase58() })).toBe(
      "signed-by-cdp",
    );
    expect(cdpSign).toHaveBeenCalledWith(tx);
    expect(phantom.connect).not.toHaveBeenCalled();
    expect(phantom.sign).not.toHaveBeenCalled();
  });

  it("after a reload the wallet is connected first, then asked to sign (Kev's first browser payment, 2026-10-13)", async () => {
    // Not connected yet, so the adapter has no signTransaction: the old order
    // looked for it before connecting and refused without ever asking the wallet.
    const phantom = wallet(buyer);
    expect("signTransaction" in phantom).toBe(false);
    const signed = await signForBuyer(escrowDeposit(), { adapter: asAdapter(phantom), cdpAddress: null });
    expect(phantom.connect).toHaveBeenCalledTimes(1);
    expect(phantom.sign).toHaveBeenCalledTimes(1);
    expect(Transaction.from(Buffer.from(signed, "base64")).signatures.find((s) => s.publicKey.equals(buyer.publicKey))?.signature).not.toBeNull();
  });

  it("a wallet already connected is not connected a second time", async () => {
    const phantom = wallet(buyer);
    await phantom.connect();
    phantom.connect.mockClear();
    await signForBuyer(escrowDeposit(), { adapter: asAdapter(phantom), cdpAddress: null });
    expect(phantom.connect).not.toHaveBeenCalled();
    expect(phantom.sign).toHaveBeenCalledTimes(1);
  });

  it("a wallet that cannot sign transactions is a refusal, even with the buyer's key", async () => {
    const readOnly = wallet(buyer, { signs: false });
    const err = await signForBuyer(escrowDeposit(), { adapter: asAdapter(readOnly), cdpAddress: null }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutError);
    expect(readOnly.sign).not.toHaveBeenCalled();
  });

  it("a wallet holding another key is never asked to sign", async () => {
    cdpSign.mockReset();
    const phantom = wallet(stranger);
    const err = await signForBuyer(authorization(), {
      adapter: asAdapter(phantom),
      cdpAddress: stranger.publicKey.toBase58(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutError);
    expect(err.step).toBe("sign");
    expect(err.message).toMatch(/nothing was charged/);
    expect(phantom.sign).not.toHaveBeenCalled();
    expect(cdpSign).not.toHaveBeenCalled();
  });

  it("no wallet at all is a refusal, not a hang", async () => {
    await expect(signForBuyer(authorization(), { adapter: null, cdpAddress: null })).rejects.toBeInstanceOf(
      CheckoutError,
    );
  });
});
