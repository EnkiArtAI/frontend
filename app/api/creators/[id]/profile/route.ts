/**
 * GET /api/creators/[id]/profile — creator profile with portfolio and stats.
 *
 * [id] accepts the user's HANDLE or UUID: every link in the app navigates by
 * handle (EnkiCard, PromptGeneratorView), while older bookmarks may carry the
 * uuid. Columns follow the LIVE schema (probed 2026-08-24): users.handle /
 * display_name / bio / avatar_url / cover_image_url; prompts.creator_id /
 * price_usd_cents / showcase_images / is_listed. The previous version
 * selected users.username and prompts.user_id — columns that do not exist —
 * so the first query errored and EVERY creator answered 404
 * (Kev, 2026-08-24: "Failed to load creator profile bei enki.artist").
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { hideAdult, viewer } from "@/lib/adult-content";
import { hiddenOwners } from "@/lib/hidden-owners";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: creatorId } = await params;

    const supabase = getSupabaseServerClient();

    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("id, handle, display_name, bio, avatar_url, cover_image_url, created_at")
      .eq(UUID.test(creatorId) ? "id" : "handle", creatorId)
      .maybeSingle();

    if (userError || !userData) {
      if (userError) console.error("[API] creator lookup failed:", userError.message);
      return NextResponse.json(
        { success: false, error: "Creator not found" },
        { status: 404 }
      );
    }
    // A banned or deleted account has no public profile (and no public wallet).
    const hidden = await hiddenOwners(supabase, [String(userData.id)]);
    if (!hidden) return NextResponse.json({ success: false, error: "Creator unavailable" }, { status: 503 });
    if (hidden.has(String(userData.id))) {
      return NextResponse.json({ success: false, error: "Creator not found" }, { status: 404 });
    }

    // Listed prompts only — the portfolio is the public shelf, not drafts.
    const { data: promptRows, error: promptsError } = await hideAdult(
      supabase
        .from("prompts")
        .select("id, title, price_usd_cents, showcase_images, published_at, created_at")
        .eq("creator_id", userData.id)
        .eq("is_listed", true)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(20),
      await viewer(supabase, request),
      userData.id,
    );

    if (promptsError) console.error("[API] Error fetching creator prompts:", promptsError.message);

    const listedPrompts = (promptRows || []).map((p) => ({
      id: p.id as string,
      title: p.title as string,
      priceUsdCents: typeof p.price_usd_cents === "number" ? p.price_usd_cents : 0,
      previewImageUrl: Array.isArray(p.showcase_images)
        ? (p.showcase_images[0] as string | undefined)
        : undefined,
      listedAt: (p.published_at ?? p.created_at) as string | undefined,
    }));

    // The payout wallet is already public on-chain the moment anyone buys
    // (it rides every 402's legs) — here it keys the foreign profile's
    // gallery, which reads generations by wallet.
    const { data: wallets } = await supabase
      .from("user_wallets")
      .select("address")
      .eq("user_id", userData.id)
      .eq("chain_family", "solana")
      .is("removed_at", null)
      .limit(1);

    return NextResponse.json({
      creator: {
        id: userData.id,
        username: userData.handle,
        displayName: userData.display_name || userData.handle,
        bio: userData.bio,
        avatarUrl: userData.avatar_url,
        coverImageUrl: userData.cover_image_url,
        joinedAt: userData.created_at,
        wallet: wallets?.[0]?.address ?? null,
      },
      // Earnings/sales come from the payments ledger once real volume flows.
      // Zeros are honest today: user_earnings does not exist in the live DB,
      // and prompt_purchases exists but is empty AND lacks the columns the
      // old query read (prompt_title → 42703; probed 2026-08-24).
      stats: {
        totalEarnings: 0,
        totalSales: 0,
        activePrompts: listedPrompts.length,
        averageRating: 0,
        totalPrompts: listedPrompts.length,
      },
      featuredPrompts: listedPrompts.slice(0, 6),
      recentSales: [],
    });
  } catch (error) {
    console.error("Error fetching creator profile:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
