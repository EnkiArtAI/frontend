import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The NFT picker shows the Helius CDN's tile of each NFT and hands over the
 * picture the list named with that tile; the picture itself is only ever read
 * through our own route (hooks/useReferenceReads, app/api/wallet/nfts/image).
 */
const ROOT = join(__dirname, "..", "..");
const PICKER = readSource(join(ROOT, "components", "enki", "NftPickerModal.tsx"));
const LAUNCHER = readSource(join(ROOT, "components", "GenerateLauncher.tsx"));

describe("the NFT picker", () => {
  it("shows the CDN's tile, never the NFT's own host", () => {
    expect(PICKER).toContain("<img src={n.thumb}");
    expect(PICKER).not.toMatch(/src=\{n\.image\}/);
  });

  it("hands over each marked NFT's picture and tile", () => {
    expect(PICKER).toContain(".filter((n) => marked.has(n.id)).map(({ image, thumb }) => ({ image, thumb }));");
  });

  it("tells no wallet from no NFTs, by the count of wallets the list read", () => {
    expect(PICKER).toMatch(/setWallets\(d\.wallets \?\? 0\);\n\s+setNfts\(d\.nfts\);/);
    expect(PICKER).toMatch(/\{nfts\?\.length === 0 && !problem && \(\n\s+<div className="enki-nftp-note"[^\n]*>\n\s+\{wallets \? `No NFTs in your \$\{wallets === 1 \? "wallet" : "wallets"\}\.` : "No Solana wallet is linked to this account yet\."\}/);
  });
});

describe("quick create's NFT button", () => {
  it("is offered only for a model that takes references, and for no more than it has left", () => {
    expect(LAUNCHER).toContain("onPickNFT={modelLimits.maxRefs > 0 ? pickNFT : undefined}");
    expect(LAUNCHER).toContain("max={Math.max(0, modelLimits.maxRefs - refCount - refsPending.length)}");
    expect(LAUNCHER).toContain("const refCount = referenceImages.length + nftImages.length;");
  });
});

describe("the empty NFT picker", () => {
  it("offers an email account to link a wallet, then reads the list again past the browser's copy", () => {
    expect(PICKER).toContain('{emailAuthed && <LinkWalletButtons buttonClass="enki-bmp-go" onLinked={() => { setNfts(null); setRound((r) => r + 1); }} />}');
    expect(PICKER).toContain('cache: round || walletsChangedRecently() ? "reload" : "default" })');
    expect(PICKER).toMatch(/\.catch\(\(e: Error\) => \{ setNfts\(\[\]\); setProblem\(e\.message\); \}\);\n\s+\}, \[round\]\);/);
  });
});

describe("the current buyer's references", () => {
  it("counts pending reads against the model cap and enables NFTs only with room", async () => {
    const { refCap, refSlots } = await import("@/lib/ui/image-view/models");
    expect(refCap({ maxRefs: 20 })).toBe(4);
    expect(refSlots(4, 2, 2)).toEqual({ room: 0, over: 0, nft: true });
    expect(refSlots(0, 0, 0).nft).toBe(false);
  });
  it("counts every sent reference in the price and the job request", () => {
    const setup = readSource(join(ROOT, "lib", "ui", "image-view", "setups.ts"));
    expect(setup).toContain('referenceImageCount: s.refs.length');
    expect(setup).toContain('referenceImages: s.refs');
    expect(readSource(join(ROOT, "components", "image-view", "useImageViewModel.ts"))).toContain('referenceImageCount: refs.length,');
  });
});
