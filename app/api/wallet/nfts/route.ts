/**
 * The signed-in user's NFTs, for the quick-create NFT picker
 * (Kev, 2026-08-22: "a popup that shows all NFTs in your logged in
 * account/wallet").
 *
 *   GET → { nfts: [{ id, name, image, thumb, collection }] }
 *
 * image is the NFT's picture (lib/wallet-nfts imageSource), thumb the Helius
 * CDN's tile of it: the picker shows the tile and reads a pick's image
 * through /api/wallet/nfts/image, never from its host.
 *
 * Reads every active Solana wallet on the account (user_wallets,
 * chain_family solana, not removed) and asks the RPC's DAS index
 * (getAssetsByOwner) for their assets. Two honest failure modes:
 *   503 "not configured"   — SOLANA_RPC_URL is empty (it currently is;
 *                            on Kev's to-do), nothing to ask.
 *   503 "no DAS index"     — the RPC answers but does not serve DAS
 *                            (plain public RPCs don't; Helius-class do).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { cdnImage, imageSource, THUMB, type DasAsset } from "@/lib/wallet-nfts";

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const rpc = process.env.SOLANA_RPC_URL?.trim();
  if (!rpc) return NextResponse.json({ error: "NFT browsing isn't configured yet" }, { status: 503 });

  const { data: wallets, error } = await supabase
    .from("user_wallets")
    .select("address")
    .eq("user_id", userId)
    .eq("chain_family", "solana")
    .is("removed_at", null);
  if (error) return NextResponse.json({ error: "Wallets unavailable" }, { status: 503 });
  if (!wallets?.length) return NextResponse.json({ nfts: [] });

  const nfts: Array<{ id: string; name: string; image: string; thumb: string; collection: string | null }> = [];
  for (const w of wallets) {
    // One page of 200 covers any realistic picker; a collector beyond that
    // still sees their first 200 rather than an error.
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "enki-nfts", method: "getAssetsByOwner",
        params: { ownerAddress: w.address, page: 1, limit: 200 },
      }),
    }).catch(() => null);
    if (!res?.ok) return NextResponse.json({ error: "NFT index unavailable" }, { status: 503 });
    const d = await res.json().catch(() => null);
    if (d?.error) {
      // Method not found = the RPC has no DAS index. Name the real problem.
      return NextResponse.json({ error: "This RPC has no NFT index (DAS)" }, { status: 503 });
    }
    for (const a of (d?.result?.items ?? []) as DasAsset[]) {
      const image = imageSource(a);
      // The picker is an image grid: an asset without a picture can't be picked.
      if (!image || a.burnt) continue;
      nfts.push({
        id: a.id,
        name: a.content?.metadata?.name || "Untitled",
        image,
        thumb: cdnImage(image, THUMB),
        collection: a.grouping?.find((g) => g.group_key === "collection")?.group_value ?? null,
      });
    }
  }
  return NextResponse.json({ nfts });
}
