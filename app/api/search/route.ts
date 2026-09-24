/**
 * GET /api/search?q=…&type=prompts|creators|all&limit=20&cursor=<offset>
 *
 * Zero cost search (Kev, 2026-09-24): Postgres full text + trigram through
 * the RPCs in migrations/2026-09-24-search.sql, no model, no paid API. The
 * ranked prompt ids are loaded as the SAME card the marketplace feed serves
 * (lib/marketplace/card.ts), so a search result drops straight into the
 * wall. Behind the same team gate as /api/marketplace/prompts (proxy.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { PROMPT_CARD_SELECT, mapPromptRow, enrichPromptCards, type PromptCardRow } from "@/lib/marketplace/card";
import { isSearchNotMigrated, searchNotMigratedResponse, searchQuery } from "@/lib/search/db";

const TYPES = new Set(["prompts", "creators", "all"]);
const MAX_LIMIT = 40;
const CREATORS_IN_ALL = 8;

type Creator = { id: string; handle: string; display_name: string | null; avatar_url: string | null };

export async function GET(req: NextRequest) {
  // 60 searches per minute per IP.
  const rate = checkRequestRateLimit(rateLimitKey(req, "search"), 60, 60 * 1000);
  if (!rate.allowed) return rateLimitResponse(rate.retryAfterSeconds);

  const { searchParams } = new URL(req.url);
  const q = searchQuery(searchParams.get("q"));
  const type = searchParams.get("type") ?? "all";
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10) || 20));
  const offset = Math.max(0, parseInt(searchParams.get("cursor") ?? "0", 10) || 0);

  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });
  if (!TYPES.has(type)) return NextResponse.json({ error: "type must be prompts, creators or all" }, { status: 400 });

  try {
    const supabase = getSupabaseServerClient();
    let prompts: Awaited<ReturnType<typeof enrichPromptCards>> = [];
    let creators: { id: string; handle: string; displayName: string; avatarUrl: string | null }[] = [];
    let hasMore = false;

    if (type !== "creators") {
      // One row past the page tells us whether a next page exists.
      const { data: ranked, error } = await supabase.rpc("search_prompts", { q, lim: limit + 1, off: offset });
      if (error) throw error;
      const page = ((ranked ?? []) as { id: string; rank: number }[]).slice(0, limit);
      hasMore = (ranked?.length ?? 0) > limit;

      if (page.length > 0) {
        const { data: rows, error: rowsError } = await supabase
          .from("prompts")
          .select(PROMPT_CARD_SELECT)
          .in("id", page.map((r) => r.id));
        if (rowsError) throw rowsError;
        // .in() loses the rank order; restore it.
        const byId = new Map(((rows ?? []) as PromptCardRow[]).map((r) => [r.id, mapPromptRow(r)]));
        const listings = page.map((r) => byId.get(r.id)).filter((p) => p !== undefined);
        prompts = await enrichPromptCards(supabase, listings);
      }
    }

    if (type !== "prompts") {
      const lim = type === "all" ? CREATORS_IN_ALL : limit;
      const { data, error } = await supabase.rpc("search_creators", { q, lim });
      if (error) throw error;
      creators = ((data ?? []) as Creator[]).map((u) => ({
        id: u.id,
        handle: u.handle,
        displayName: u.display_name || u.handle,
        avatarUrl: u.avatar_url,
      }));
    }

    return NextResponse.json({
      query: q,
      prompts,
      creators,
      hasMore,
      nextCursor: hasMore ? String(offset + limit) : undefined,
    });
  } catch (error) {
    if (isDbUnreachable(error)) return dbUnavailableResponse();
    if (isSearchNotMigrated(error)) return searchNotMigratedResponse();
    console.error("/api/search failed:", error);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
