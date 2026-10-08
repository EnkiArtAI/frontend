import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Wallet NFTs as reference images (Kev, 2026-08-22; wired 2026-10-08). The
 * list names a picture the browser can show, through the Helius CDN, so no
 * host's CORS or downtime decides it.
 */

const s = vi.hoisted(() => ({ user: null as string | null, wallets: [] as string[] | null, linked: [] as string[] | null, order: [] as unknown[][], limits: {} as Record<string, number> }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => s.user }));
// user_wallets and linked_wallets as PostgREST answers them: the order asked for is recorded, the limit applied.
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: (table: string) => {
      const rows = table === "linked_wallets" ? s.linked : s.wallets;
      let limit = Infinity;
      const c: Record<string, unknown> = {
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve(
            rows ? { data: rows.slice(0, limit).map((address) => ({ address })), error: null } : { data: null, error: { message: "down" } },
          ).then(ok),
        order: (...a: unknown[]) => { s.order.push(a); return c; },
        limit: (n: number) => { limit = n; s.limits[table] = n; return c; },
      };
      for (const m of ["select", "eq", "is"]) c[m] = () => c;
      return c;
    },
  }),
}));

import { GET as list } from "../../app/api/wallet/nfts/route";
import { GET as image } from "../../app/api/wallet/nfts/image/route";

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
  s.linked = [];
  s.limits = {};
  s.order = [];
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

describe("the NFT list reads the wallets", () => {
  // Base58 has no 0, O, I or l: "Qther" is an address, "Other" would not be.
  const OTHER = "QtherBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  it("asks every wallet at once, for up to 1000 assets each", async () => {
    s.wallets = [WALLET, OTHER];
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    net(async () => {
      if (rpcCalls.length === 2) release();
      await both;
      return result({ items: [] });
    });
    expect((await list(ask("/api/wallet/nfts"))).status).toBe(200);
    expect(rpcCalls.map((c) => [c.method, c.params])).toEqual([
      ["getAssetsByOwner", { ownerAddress: WALLET, page: 1, limit: 1000 }],
      ["getAssetsByOwner", { ownerAddress: OTHER, page: 1, limit: 1000 }],
    ]);
  }, 1000);

  it("reads three wallets at most, the account's own first: each costs a paid call", async () => {
    s.wallets = [WALLET, OTHER, "ThirdDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", "FourthEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"];
    const body = await listOf();
    expect(rpcCalls).toHaveLength(3);
    expect(body.wallets).toBe(3);
    expect(s.order).toEqual([["is_primary", { ascending: false }]]);
  });

  it("reads the wallets the account linked for their NFTs too, three at most, each wallet once", async () => {
    const THIRD = "ThirdDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    s.linked = [OTHER, WALLET, THIRD, "FourthEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"];
    const body = await listOf();
    expect(rpcCalls.map((c) => c.params.ownerAddress)).toEqual([WALLET, OTHER, THIRD]);
    expect(body.wallets).toBe(3);
    expect(s.limits.linked_wallets).toBe(3);
  });

  it("says the wallets are unavailable when the linked ones cannot be read, rather than leave them out", async () => {
    s.linked = null;
    expect((await listOf()).error).toBe("Wallets unavailable");
    expect(rpcCalls).toEqual([]);
  });

  it("a wallet that cannot be read costs only its own NFTs", async () => {
    s.wallets = [WALLET, OTHER];
    net((c) => (c.params.ownerAddress === WALLET ? new Response("busy", { status: 429 }) : result({ items: [nft({ links: { image: "https://links.test/e.png" } })] })));
    const res = await list(ask("/api/wallet/nfts"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Listed;
    expect(body.nfts.map((x) => x.image)).toEqual(["https://links.test/e.png"]);
    // Both wallets are the account's, the one that answered and the one that did not.
    expect(body.wallets).toBe(2);
  });

  it.each([
    ["busy", () => new Response("slow down", { status: 429 }), "The NFT index is busy right now. Try again in a minute."],
    ["without the index", () => Response.json({ jsonrpc: "2.0", id: "x", error: { code: -32601, message: "Method not found" } }), "This RPC has no NFT index (DAS)"],
    ["down", () => { throw new TypeError("fetch failed"); }, "NFT index unavailable"],
  ])("names the real problem when no wallet could be read (%s)", async (_n, rpc, error) => {
    net(rpc);
    const res = await list(ask("/api/wallet/nfts"));
    expect([res.status, ((await res.json()) as Listed).error]).toEqual([503, error]);
  });

  it("an account without a Solana wallet gets an empty list, and costs no call", async () => {
    s.wallets = [];
    expect(await listOf()).toEqual({ nfts: [], wallets: 0 });
    expect(rpcCalls).toEqual([]);
  });

  it("a stored wallet that is no Solana address costs no call", async () => {
    s.wallets = ["lowercasedbeforepr69lowercasedbeforepr6900"];
    expect(await listOf()).toEqual({ nfts: [], wallets: 0 });
    expect(rpcCalls).toEqual([]);
  });

  it("says when NFT browsing is not configured, and when the wallets cannot be read", async () => {
    vi.stubEnv("SOLANA_RPC_URL", "");
    expect((await listOf()).error).toBe("NFT browsing isn't configured yet");
    vi.stubEnv("SOLANA_RPC_URL", RPC);
    s.wallets = null;
    expect((await listOf()).error).toBe("Wallets unavailable");
    expect(rpcCalls).toEqual([]);
  });

  it("answers 401 to nobody, and asks nothing", async () => {
    net(() => result({ items: [] }));
    s.user = null;
    const res = await list(new NextRequest("http://enki.test/api/wallet/nfts"));
    expect(res.status).toBe(401);
    expect(rpcCalls).toEqual([]);
  });
});

describe("the NFT list costs", () => {
  it("answers privately, for a minute, per session", async () => {
    net(() => result({ items: [] }));
    const res = await list(ask("/api/wallet/nfts"));
    expect([res.headers.get("Cache-Control"), res.headers.get("Vary")]).toEqual(["private, max-age=60", "X-Session-Token"]);
  });

  it("holds one account to thirty lists an hour, before any paid call; another account is not held", async () => {
    net(() => result({ items: [] }));
    for (let i = 0; i < 30; i++) expect((await list(ask("/api/wallet/nfts", "collector"))).status).toBe(200);
    const eleventh = await list(ask("/api/wallet/nfts", "collector"));
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("Retry-After")).toEqual(expect.any(String));
    expect(rpcCalls).toHaveLength(30);
    expect((await list(ask("/api/wallet/nfts", "someone-else"))).status).toBe(200);
    // Not a minute's window: an hour later than a minute still holds.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect((await list(ask("/api/wallet/nfts", "collector"))).status).toBe(429);
    vi.restoreAllMocks();
  });
});

describe("a picked NFT's image", () => {
  const REF = "width=1024,height=1024,fit=scale-down,format=webp,quality=85,anim=false";
  const CAP = 3 * 1024 * 1024;
  let cdnCalls: { url: string; init?: RequestInit }[] = [];
  const webp = (bytes = 10) => new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/webp" } });
  const cdn = (answer: (url: string) => Response | Promise<Response> = () => webp()) => {
    cdnCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      cdnCalls.push({ url, init });
      return answer(url);
    }));
  };
  const pick = (src: string, user?: string) => image(ask(`/api/wallet/nfts/image?src=${encodeURIComponent(src)}`, user));

  it("is the CDN's 1024 px still of the named image, read here and handed on as bytes", async () => {
    cdn(() => webp(1234));
    const res = await pick("https://files.test/a.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect((await res.arrayBuffer()).byteLength).toBe(1234);
    expect(cdnCalls.map((c) => c.url)).toEqual([`${CDN}/${REF}/https://files.test/a.png`]);
  });

  it("reads an IPFS image through a gateway that answers", async () => {
    cdn();
    await pick("ipfs://bafyabc/1.png");
    expect(cdnCalls.map((c) => c.url)).toEqual([`${CDN}/${REF}/https://ipfs.filebase.io/ipfs/bafyabc/1.png`]);
  });

  it("fetches nothing for a source that is no web address", async () => {
    cdn();
    for (const src of ["javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd", ""]) {
      expect((await pick(src)).status).toBe(400);
    }
    expect((await image(ask("/api/wallet/nfts/image"))).status).toBe(400);
    expect(cdnCalls).toEqual([]);
  });

  it("refuses a redirect and gives the read a deadline", async () => {
    cdn();
    await pick("https://files.test/a.png");
    expect(cdnCalls[0].init?.redirect).toBe("error");
    expect(cdnCalls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses an image past the cap rather than cut it", async () => {
    const stream = (size: number) => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(size)); c.close(); } });
    cdn(() => new Response(stream(CAP + 1), { headers: { "Content-Type": "image/webp" } }));
    expect((await pick("https://files.test/a.png")).status).toBe(502);
    cdn(() => new Response(new Uint8Array(1), { headers: { "Content-Type": "image/webp", "Content-Length": String(CAP + 1) } }));
    expect((await pick("https://files.test/a.png")).status).toBe(502);
    cdn(() => new Response(stream(CAP), { headers: { "Content-Type": "image/webp" } }));
    expect((await pick("https://files.test/a.png")).status).toBe(200);
  });

  it.each([
    ["an SVG", () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } })],
    ["an error page", () => new Response("<html>", { headers: { "Content-Type": "text/html" } })],
    ["a refusal", () => new Response("no", { status: 415, headers: { "Content-Type": "image/webp" } })],
    ["no answer in time", () => { throw new DOMException("timed out", "TimeoutError"); }],
  ])("is no image when the CDN answers %s", async (_n, answer) => {
    cdn(answer);
    const res = await pick("https://files.test/a.png");
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([502, "This NFT's image could not be loaded"]);
  });

  it("holds one account to forty images a minute", async () => {
    cdn();
    for (let i = 0; i < 40; i++) expect((await pick("https://files.test/a.png", "picker")).status).toBe(200);
    expect((await pick("https://files.test/a.png", "picker")).status).toBe(429);
    expect(cdnCalls).toHaveLength(40);
  });

  it("answers 401 to nobody, and fetches nothing", async () => {
    cdn();
    s.user = null;
    expect((await image(new NextRequest("http://enki.test/api/wallet/nfts/image?src=https%3A%2F%2Ffiles.test%2Fa.png"))).status).toBe(401);
    expect(cdnCalls).toEqual([]);
  });
});
