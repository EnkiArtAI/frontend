/**
 * The signed-in user's NFTs, for the quick-create NFT picker
 * (Kev, 2026-08-22: "a popup that shows all NFTs in your logged in
 * account/wallet").
 *
 *   GET → { nfts: [{ id, name, image, thumb, collection }], wallets }
 *
 * image is the NFT's picture (lib/wallet-nfts imageSource), thumb the Helius
 * CDN's tile of it: the picker shows the tile and reads a pick's image
 * through /api/wallet/nfts/image, never from its host.
 *
 * Up to three Solana wallets of the account are read at once through the
 * RPC's index (getAssetsByOwner, up to 1000 assets a wallet); `wallets` says
 * how many, so the picker tells "no wallet" from "no NFTs". When none could
 * be read, the answer names the real problem:
 *   503 "isn't configured yet" — SOLANA_RPC_URL is empty.
 *   503 "busy"                 — the RPC answered 429.
 *   503 "no NFT index (DAS)"   — the RPC does not serve DAS (plain public RPCs don't).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { askDas, cdnImage, DAS_FAILURE, imageSource, solanaWallets, THUMB, type DasAsset } from "@/lib/wallet-nfts";

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const wallets = await solanaWallets(supabase, userId);
  if (!wallets) return NextResponse.json({ error: "Wallets unavailable" }, { status: 503 });
  if (!wallets.length) return NextResponse.json({ nfts: [], wallets: 0 });

  const rpc = process.env.SOLANA_RPC_URL?.trim();
  if (!rpc) return NextResponse.json({ error: "NFT browsing isn't configured yet" }, { status: 503 });

  // A wallet beyond 1000 assets shows its first 1000 rather than an error.
  const answers = await Promise.all(
    wallets.map((ownerAddress) =>
      askDas<{ items?: DasAsset[] }>(rpc, "getAssetsByOwner", { ownerAddress, page: 1, limit: 1000 }, req.signal),
    ),
  );
  const read = answers.flatMap((a) => ("result" in a ? [a.result] : []));
  if (!read.length) {
    const failed = answers.flatMap((a) => ("failure" in a ? [a.failure] : []));
    return NextResponse.json({ error: DAS_FAILURE[failed[0]] }, { status: 503 });
  }

  const nfts = read.flatMap((r) => r.items ?? []).flatMap((a) => {
    const image = imageSource(a);
    // The picker is an image grid: an asset without a picture can't be picked.
    return image && !a.burnt
      ? [{
          id: a.id,
          name: a.content?.metadata?.name || "Untitled",
          image,
          thumb: cdnImage(image, THUMB),
          collection: a.grouping?.find((g) => g.group_key === "collection")?.group_value ?? null,
        }]
      : [];
  });
  return NextResponse.json({ nfts, wallets: wallets.length });
}
