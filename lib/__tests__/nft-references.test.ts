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

describe("the NFT picker", () => {
  it("shows the CDN's tile, never the NFT's own host", () => {
    expect(PICKER).toContain("<img src={n.thumb}");
    expect(PICKER).not.toMatch(/src=\{n\.image\}/);
  });

  it("hands over each marked NFT's picture and tile", () => {
    expect(PICKER).toContain(".filter((n) => marked.has(n.id)).map(({ image, thumb }) => ({ image, thumb }));");
  });
});
