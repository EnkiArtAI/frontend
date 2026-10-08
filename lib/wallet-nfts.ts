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
