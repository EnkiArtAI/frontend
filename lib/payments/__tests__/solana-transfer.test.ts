import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
const mocks = vi.hoisted(() => ({ account: vi.fn() }));
vi.mock("@/lib/payments/solana", () => ({
  solanaConnection: () => ({ getAccountInfo: mocks.account }),
  usdcMint: () => new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
}));
import { MAX_PRIORITY_FEE_MICROLAMPORTS, priorityFeeMicroLamports, USDC_DECIMALS, findMissingAtas } from "../solana-transfer";

describe("priorityFeeMicroLamports", () => {
  it("picks the p75 of recent fees regardless of sample order", () => {
    const recent = [700, 0, 400, 100, 500, 200, 600, 300].map((prioritizationFee) => ({
      prioritizationFee,
    }));
    expect(priorityFeeMicroLamports(recent)).toBe(500);
  });

  it("returns 0 on an idle fee market (no samples or all-zero)", () => {
    expect(priorityFeeMicroLamports([])).toBe(0);
    expect(priorityFeeMicroLamports([{ prioritizationFee: 0 }])).toBe(0);
  });

  it("caps spikes at MAX_PRIORITY_FEE_MICROLAMPORTS", () => {
    expect(priorityFeeMicroLamports([{ prioritizationFee: 50_000_000 }])).toBe(
      MAX_PRIORITY_FEE_MICROLAMPORTS,
    );
  });
});


describe("shared direct-transfer guards", () => {
  it("keeps USDC precision at six decimals", () => { expect(USDC_DECIMALS).toBe(6); });
  it("reads canonical recipient ATAs at confirmed commitment without changing the accounts", async () => {
    mocks.account.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ data: Buffer.alloc(165) });
    const owners = [3,4].map(seed => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey);
    expect(await findMissingAtas(owners.map(owner => owner.toBase58()))).toEqual([owners[0].toBase58()]);
    const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    for (let i=0;i<owners.length;i++) expect(mocks.account).toHaveBeenNthCalledWith(i+1, getAssociatedTokenAddressSync(mint,owners[i]), "confirmed");
  });
  it("does not treat a failed account read as a missing ATA", async () => {
    mocks.account.mockReset().mockRejectedValue(new Error("RPC unavailable"));
    const owner=Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
    await expect(findMissingAtas([owner])).rejects.toThrow("RPC unavailable");
  });
});
