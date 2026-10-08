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
const BUYER = readSource(join(ROOT, "components", "PromptGeneratorView.tsx"));
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
    expect(PICKER).toContain('{nfts?.length === 0 && !problem && <div className="enki-nftp-note">{wallets ? `No NFTs in your ${wallets === 1 ? "wallet" : "wallets"}.` : "No Solana wallet is linked to this account yet."}</div>}');
  });
});

describe("the buyer page's references", () => {
  it("are as many as the selected model takes, not ten, with those still loading counted", () => {
    expect(BUYER).toContain("const maxRefs = core.entry?.maxRefs ?? 0;");
    expect(BUYER).toContain("const refsTaken = refs.length + refsPending.length;");
    expect(BUYER).toContain("Array.from(files).slice(0, Math.max(0, maxRefs - refsTaken)).forEach(file => {");
    expect(BUYER).toContain("setRefs(prev => prev.length >= maxRefs ? prev : [...prev, url]);");
    expect(BUYER).toContain("}, [maxRefs, refsTaken, readRef]);");
    expect(BUYER).toContain('<span className="pgv-ref-count">{refs.length}/{maxRefs}</span>');
    expect(BUYER).toMatch(/className="pgv-ref-add"\n\s+onClick=\{\(\) => fileRef\.current\?\.click\(\)\}\n\s+disabled=\{refsTaken >= maxRefs\}/);
    expect(BUYER).not.toMatch(/\b10 - refs\.length|>= 10\b|\/10</);
  });

  it("offer + NFT only for a model that takes references, and read a pick like quick create", () => {
    expect(BUYER).toMatch(/\{maxRefs > 0 && \(\n\s+<button type="button" className="pgv-ref-nft" onClick=\{\(\) => setNftPickerOpen\(true\)\}\n\s+disabled=\{refsTaken >= maxRefs\}/);
    expect(BUYER).toContain("{nftPickerOpen && <NftPickerModal max={Math.max(0, maxRefs - refsTaken)} onPick={addNfts} onClose={() => setNftPickerOpen(false)} />}");
    const add = BUYER.slice(BUYER.indexOf("const addNfts = useCallback((picks: NftPick[]) => {"), BUYER.indexOf("const removeRef = "));
    expect(add).toContain("picks.forEach(p => void readRef(p).then(url => {");
    expect(add).toMatch(/if \(!url\) \{\n\s+toast\(\{ title: "NFT image unavailable"[^\n]*variant: "destructive" \}\);\n\s+return;/);
    expect(add).toContain("setRefs(prev => prev.length >= maxRefs ? prev : [...prev, url]);");
    expect(add).toContain("}, [maxRefs, readRef, toast]);");
  });
});

describe("quick create's NFT button", () => {
  it("is offered only for a model that takes references, and for no more than it has left", () => {
    expect(LAUNCHER).toContain("onPickNFT={modelLimits.maxRefs > 0 ? pickNFT : undefined}");
    expect(LAUNCHER).toContain("max={Math.max(0, modelLimits.maxRefs - refCount - refsPending.length)}");
    expect(LAUNCHER).toContain("const refCount = referenceImages.length + nftImages.length;");
  });
});
