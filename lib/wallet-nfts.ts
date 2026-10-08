/**
 * A wallet's NFTs as pictures this app can use: shared by the picker's list
 * (app/api/wallet/nfts) and the read of one picked NFT's image
 * (app/api/wallet/nfts/image).
 *
 * An NFT names its image on whatever host its creator chose, and those hosts
 * are often gone, send no CORS header, or throttle (ipfs.io answers 429). So
 * no image address is used as it stands: it goes through the Helius image
 * CDN, which fetches and resizes it on Helius's network, never on ours.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type DasAsset = {
  id: string;
  burnt?: boolean;
  content?: {
    metadata?: { name?: string };
    links?: { image?: string };
    files?: Array<{ uri?: string; mime?: string }>;
  };
  grouping?: Array<{ group_key: string; group_value: string }>;
};

/** The picker's tiles. */
export const THUMB = "width=256,height=256,fit=scale-down,format=jpeg,quality=80";

const CDN = "https://cdn.helius-rpc.com/cdn-cgi/image";
/** Where IPFS content is read: the gateways NFTs usually name throttle (ipfs.io answers 429) or are gone. */
const IPFS = "https://ipfs.filebase.io/ipfs/";
/** An address from an NFT's own metadata is as long as its creator likes; a list of them must stay an answer. */
const SOURCE_MAX = 2048;

/** The CDN's copy of an image, resized on Helius's network. It passes the origin's CORS header through and adds none. */
export const cdnImage = (source: string, options: string) => `${CDN}/${options}/${source}`;

/** An image address the CDN can fetch: http(s), IPFS through a gateway that answers; null for anything else. */
export function httpSource(uri: string | undefined): string | null {
  if (!uri || uri.length > SOURCE_MAX) return null;
  const rewritten = uri
    .trim()
    .replace(/^ipfs:\/\/(?:ipfs\/)?/i, IPFS)
    // cloudflare-ipfs.com was retired in 2024 and sent everything to ipfs.io.
    .replace(/^https?:\/\/(?:ipfs\.io|nftstorage\.link|cloudflare-ipfs\.com)\/ipfs\//i, IPFS)
    .replace(/^https?:\/\/([a-z0-9]+)\.ipfs\.(?:nftstorage\.link|dweb\.link)(?=\/|$)/i, (_, cid: string) => IPFS + cid);
  try {
    const url = new URL(rewritten);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The NFT's picture: its image file first (what Helius's own cdn_uri wraps),
 * then links.image, then a file of unknown type. A file of a known other type
 * (a video, the metadata JSON) is no picture, and neither is an SVG: the CDN
 * passes it through unresized, and no model takes one.
 */
export function imageSource(a: DasAsset): string | null {
  const files = a.content?.files ?? [];
  return [
    files.find((f) => f.mime?.startsWith("image/") && f.mime !== "image/svg+xml")?.uri,
    a.content?.links?.image,
    files.find((f) => !f.mime)?.uri,
  ].map(httpSource).find((u) => u !== null) ?? null;
}

/** A Solana address: base58, 32 to 44 characters. */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Each wallet read is one paid index call (10 Helius credits) every time the picker opens. */
const WALLETS_READ = 3;
/** Wallets an account may link for their NFTs (app/api/wallet/linked): each is one more such call. */
export const MAX_LINKED = 3;

/**
 * The Solana wallets to read for an account, its own one first, then those it
 * linked for their NFTs, each once; or null when the database cannot say. A
 * stored value that is no Solana address can hold nothing, so it costs no
 * call: on 2026-10-08, 6 of the 15 live rows had been lowercased before PR #69
 * and are not base58 any more.
 */
export async function solanaWallets(supabase: SupabaseClient, userId: string): Promise<string[] | null> {
  const [own, linked] = await Promise.all([
    supabase
      .from("user_wallets")
      .select("address")
      .eq("user_id", userId)
      .eq("chain_family", "solana")
      .is("removed_at", null)
      .order("is_primary", { ascending: false })
      .limit(WALLETS_READ),
    // Read here and nowhere else: a linked wallet never signs in, pays or gets paid.
    supabase.from("linked_wallets").select("address").eq("user_id", userId).limit(MAX_LINKED),
  ]);
  if (own.error || linked.error) return null;
  const addresses = [...(own.data ?? []), ...(linked.data ?? [])].map((w) => String(w.address));
  return [...new Set(addresses)].filter((a) => SOLANA_ADDRESS.test(a));
}

export type DasFailure = "busy" | "no-das" | "down";

/** What the picker shows for each: the real problem, not one "unavailable" for all. */
export const DAS_FAILURE: Record<DasFailure, string> = {
  busy: "The NFT index is busy right now. Try again in a minute.",
  "no-das": "This RPC has no NFT index (DAS)",
  down: "NFT index unavailable",
};

/** One index call: 10 Helius credits. The RPC URL carries its key, so it is never logged or returned. */
export async function askDas<T>(
  rpc: string,
  method: string,
  params: object,
  signal: AbortSignal,
): Promise<{ result: T } | { failure: DasFailure }> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "enki-nfts", method, params }),
    // An index that never answers must not hold the picker for good.
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  }).catch(() => null);
  // Helius answers 429 past the plan's rate limit: later works.
  if (res?.status === 429) return { failure: "busy" };
  const d = await res?.json().catch(() => null);
  // Method not found: a plain RPC, without the index.
  if (d?.error?.code === -32601) return { failure: "no-das" };
  return res?.ok && d?.result ? { result: d.result as T } : { failure: "down" };
}

/**
 * A reference image: at most 1024 px, the edge the image check judges at, as
 * one still WebP, the format every reference travels in (lib/shrink-image).
 * One that size stays far below the 4.5 MB a function may answer.
 */
export const FULL = "width=1024,height=1024,fit=scale-down,format=webp,quality=85,anim=false";

/** A response body of at most `cap` bytes, or null: a larger one is refused, never cut short. */
export async function readCapped(res: Response, cap: number): Promise<Blob | null> {
  if (Number(res.headers.get("content-length")) > cap) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let size = 0; ; ) {
    const { done, value } = await reader.read();
    if (done) return new Blob(parts);
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
}
