/**
 * GET /api/search/suggest?q=…
 *
 * Typeahead for the search box: up to 8 listed prompt titles by trigram
 * prefix and up to 4 active creators, from the RPCs in
 * migrations/2026-09-24-search.sql. Nothing metered, nothing encrypted.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { isSearchNotMigrated, searchNotMigratedResponse, searchQuery } from "@/lib/search/db";
import { viewer } from "@/lib/adult-content";

const TITLES = 8;
const CREATORS = 4;

type Title = { id: string; title: string };
type Creator = { id: string; handle: string; display_name: string | null; avatar_url: string | null };

export async function GET(req: NextRequest) {
  // A keystroke each: 120 per minute per IP.
  const rate = checkRequestRateLimit(rateLimitKey(req, "search-suggest"), 120, 60 * 1000);
  if (!rate.allowed) return rateLimitResponse(rate.retryAfterSeconds);

  const q = searchQuery(new URL(req.url).searchParams.get("q"));
  if (!q) return NextResponse.json({ titles: [], creators: [] });

  try {
    const supabase = getSupabaseServerClient();
    const { showAdult } = await viewer(supabase, req);
    const [titles, creators] = await Promise.all([
      supabase.rpc("suggest_titles", { q, lim: TITLES, show_adult: showAdult }),
      supabase.rpc("search_creators", { q, lim: CREATORS, show_adult: showAdult }),
    ]);
    if (titles.error) throw titles.error;
    if (creators.error) throw creators.error;

    return NextResponse.json({
      titles: ((titles.data ?? []) as Title[]).map((t) => ({ id: t.id, title: t.title })),
      creators: ((creators.data ?? []) as Creator[]).map((u) => ({
        id: u.id,
        handle: u.handle,
        displayName: u.display_name || u.handle,
        avatarUrl: u.avatar_url,
      })),
    });
  } catch (error) {
    if (isDbUnreachable(error)) return dbUnavailableResponse();
    if (isSearchNotMigrated(error)) return searchNotMigratedResponse();
    console.error("/api/search/suggest failed:", error);
    return NextResponse.json({ error: "Suggestions failed" }, { status: 500 });
  }
}
