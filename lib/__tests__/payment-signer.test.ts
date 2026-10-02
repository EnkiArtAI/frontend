import { describe, it, expect, vi } from "vitest";
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

/** A wallet-adapter stand-in holding `key`, disconnected like after a reload. */
function wallet(key: Keypair) {
  const w = {
    connected: false,
    publicKey: null as Keypair["publicKey"] | null,
    connect: vi.fn(async () => {
      w.connected = true;
      w.publicKey = key.publicKey;
    }),
    signTransaction: vi.fn(async (tx: Transaction) => {
      tx.partialSign(key);
      return tx;
    }),
  };
  return w;
}
const asAdapter = (w: ReturnType<typeof wallet>) => w as unknown as Adapter;

describe("buyerOf", () => {
  it("names the one signer the fee payer left unsigned", () => {
    expect(buyerOf(authorization())).toBe(buyer.publicKey.toBase58());
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
    expect(phantom.signTransaction).not.toHaveBeenCalled();
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
    expect(phantom.signTransaction).not.toHaveBeenCalled();
    expect(cdpSign).not.toHaveBeenCalled();
  });

  it("no wallet at all is a refusal, not a hang", async () => {
    await expect(signForBuyer(authorization(), { adapter: null, cdpAddress: null })).rejects.toBeInstanceOf(
      CheckoutError,
    );
  });
});
