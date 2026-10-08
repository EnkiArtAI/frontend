import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Wallet NFTs as reference images (Kev, 2026-08-22; wired 2026-10-08). The
 * list names a picture the browser can show, through the Helius CDN, so no
 * host's CORS or downtime decides it.
 */

const s = vi.hoisted(() => ({ user: null as string | null, wallets: [] as string[] | null }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => s.user }));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => {
    const c: Record<string, unknown> = {
      then: (ok: (v: unknown) => unknown) =>
        Promise.resolve(
          s.wallets ? { data: s.wallets.map((address) => ({ address })), error: null } : { data: null, error: { message: "down" } },
        ).then(ok),
    };
    for (const m of ["from", "select", "eq", "is", "order", "limit"]) c[m] = () => c;
    return { from: () => c };
  },
}));

import { GET as list } from "../../app/api/wallet/nfts/route";

const RPC = "https://rpc.test/?api-key=k";
const CDN = "https://cdn.helius-rpc.com/cdn-cgi/image";
const TILE = "width=256,height=256,fit=scale-down,format=jpeg,quality=80";
const WALLET = "Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ASSET = "AssetCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

type Call = { method: string; params: Record<string, unknown> };
let rpcCalls: Call[] = [];
const net = (rpc: (c: Call) => Response | Promise<Response>) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== RPC) throw new Error(`unexpected fetch ${url}`);
    const c = JSON.parse(String(init?.body)) as Call;
    rpcCalls.push(c);
    return rpc(c);
  }));
const result = (r: unknown) => Response.json({ jsonrpc: "2.0", id: "x", result: r });
type Content = { links?: { image?: string }; files?: { uri?: string; mime?: string }[]; metadata?: { name?: string } };
const nft = (content: Content, extra: Record<string, unknown> = {}) => ({ id: ASSET, content, ...extra });

// Every request is its own account unless a test names one: the real limiter keeps counting across tests.
let n = 0;
const ask = (path: string, user = `user-${++n}`) => {
  s.user = user;
  return new NextRequest(`http://enki.test${path}`, { headers: { "X-Session-Token": "tok" } });
};
type Listed = { nfts: { id: string; image: string; thumb: string }[]; wallets?: number; error?: string };
const listOf = async (...assets: unknown[]) => {
  net(() => result({ items: assets }));
  return (await (await list(ask("/api/wallet/nfts"))).json()) as Listed;
};

beforeEach(() => {
  s.wallets = [WALLET];
  rpcCalls = [];
  vi.stubEnv("SOLANA_RPC_URL", RPC);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("the NFT list picks a picture that loads", () => {
  it("shows an NFT by its image file, through the CDN at tile size", async () => {
    const { nfts } = await listOf(nft({
      links: { image: "https://links.test/a.png" },
      files: [{ uri: "https://files.test/meta.json", mime: "application/json" }, { uri: "https://files.test/a.png", mime: "image/png" }],
    }));
    expect(nfts.map((x) => [x.image, x.thumb])).toEqual([["https://files.test/a.png", `${CDN}/${TILE}/https://files.test/a.png`]]);
  });

  it("falls back to links.image, then a file of unknown type, and leaves out what has no picture", async () => {
    const { nfts } = await listOf(
      nft({ links: { image: "https://links.test/b.png" }, files: [{ uri: "https://files.test/v.mp4", mime: "video/mp4" }] }),
      nft({ files: [{ uri: "https://files.test/v.mp4", mime: "video/mp4" }, { uri: "https://files.test/c" }] }),
      nft({ files: [{ uri: "https://files.test/only.mp4", mime: "video/mp4" }] }),
      nft({ links: { image: "data:image/png;base64,AAAA" } }),
      nft({ links: { image: "https://links.test/burnt.png" } }, { burnt: true }),
    );
    expect(nfts.map((x) => x.image)).toEqual(["https://links.test/b.png", "https://files.test/c"]);
  });

  it("passes over an SVG file, which no model takes, and an address too long to list", async () => {
    const { nfts } = await listOf(
      nft({ links: { image: "https://links.test/d.png" }, files: [{ uri: "https://files.test/d.svg", mime: "image/svg+xml" }] }),
      nft({ links: { image: `https://links.test/${"x".repeat(2049)}` } }),
    );
    expect(nfts.map((x) => x.image)).toEqual(["https://links.test/d.png"]);
  });

  it.each([
    ["ipfs://bafyabc/1.png", "https://ipfs.filebase.io/ipfs/bafyabc/1.png"],
    ["ipfs://ipfs/bafyabc/1.png", "https://ipfs.filebase.io/ipfs/bafyabc/1.png"],
    ["https://ipfs.io/ipfs/bafyabc/1.png", "https://ipfs.filebase.io/ipfs/bafyabc/1.png"],
    ["https://nftstorage.link/ipfs/bafyabc/1.png", "https://ipfs.filebase.io/ipfs/bafyabc/1.png"],
    ["https://bafyabc.ipfs.nftstorage.link/1.png", "https://ipfs.filebase.io/ipfs/bafyabc/1.png"],
    ["https://cloudflare-ipfs.com/ipfs/bafyabc/1.png", "https://ipfs.filebase.io/ipfs/bafyabc/1.png"],
    ["https://arweave.net/abc", "https://arweave.net/abc"],
  ])("reads %s from a gateway that answers", async (from, to) => {
    const { nfts } = await listOf(nft({ links: { image: from } }));
    expect(nfts.map((x) => x.image)).toEqual([to]);
  });
});
