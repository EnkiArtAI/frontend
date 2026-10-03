/**
 * Username (users.handle) API.
 *
 *   GET  ?name=foo → { valid, available }        (live check while typing)
 *   GET            → { handle }                   (session user's own handle)
 *   POST { candidates: string[] } → { available } (batch check for suggestions)
 *   PUT  { handle } → sets it once for the session user (409 if taken/already set)
 *   PATCH { hideFromLeaderboard?, adultConfirmed? } → the session user's preferences
 *
 * handle is citext in the DB, so equality checks are case-insensitive; we
 * normalize to lowercase anyway so display is consistent.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { normalizeHandle as normalize, usableHandle as usable } from "@/lib/handle-rules";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  const supabase = getSupabaseServerClient();

  if (name === null) {
    // Own identity bits (handle + role) for the session user — role drives the
    // Admin section's visibility client-side. Admin APIs must re-check server-side.
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const wantStats = req.nextUrl.searchParams.get("stats") === "1";
    let row: {
      handle: string | null;
      role?: string;
      bio?: string | null;
      avatar_url?: string | null;
      cover_image_url?: string | null;
      hide_from_leaderboard?: boolean | null;
      adult_confirmed_at?: string | null;
    } | null = null;
    // Row + count run in parallel — the profile header waits on this response.
    const [res, countRes] = await Promise.all([
      supabase
        .from("users")
        .select("handle, role, bio, avatar_url, cover_image_url, hide_from_leaderboard, adult_confirmed_at")
        .eq("id", userId)
        .maybeSingle(),
      wantStats
        ? supabase.from("prompts").select("id", { count: "exact", head: true }).eq("creator_id", userId)
        : Promise.resolve({ count: null as number | null }),
    ]);
    if (res.error) {
      // A column the full read names may be missing (a migration not run yet,
      // a stale schema cache). Keep handle and role, which exist: dropping the
      // role locked every beta user out at the gate, and a null handle would
      // re-trigger the first-login name picker for everyone.
      const fb = await supabase.from("users").select("handle, role").eq("id", userId).maybeSingle();
      row = fb.data;
    } else {
      row = res.data;
    }
    if (!row) return NextResponse.json({ error: "No user for session" }, { status: 404 });
    // ?stats=1 → the user's total prompt count (profile header). A plain COUNT
    // on prompts.creator_id — cheap with an index, never drifts.
    const promptCount = wantStats ? (countRes.count ?? 0) : null;
    return NextResponse.json({
      // The caller's own id. Not a secret to them, and the recovery file needs
      // it: it is the mapping our database holds, so a user who keeps it can be
      // re-linked to their wallet even if that database is lost.
      id: userId,
      handle: row.handle ?? null,
      role: row.role ?? "user",
      bio: row.bio ?? null,
      avatarUrl: row.avatar_url ?? null,
      coverUrl: row.cover_image_url ?? null,
      hideFromLeaderboard: row.hide_from_leaderboard ?? false,
      adultConfirmed: Boolean(row.adult_confirmed_at),
      promptCount,
    });
  }

  const limit = checkRequestRateLimit(rateLimitKey(req, "handle:check"), 60, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const handle = normalize(name);
  if (!usable(handle)) return NextResponse.json({ valid: false, available: false });
  const { data } = await supabase.from("users").select("id").eq("handle", handle).maybeSingle();
  return NextResponse.json({ valid: true, available: !data });
}

export async function POST(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "handle:batch"), 20, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  let candidates: unknown;
  try {
    ({ candidates } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!Array.isArray(candidates)) return NextResponse.json({ error: "candidates must be an array" }, { status: 400 });

  const cleaned = [...new Set(candidates.filter((c): c is string => typeof c === "string").map(normalize))]
    .filter(usable)
    .slice(0, 12);
  if (cleaned.length === 0) return NextResponse.json({ available: [] });

  const supabase = getSupabaseServerClient();
  const { data } = await supabase.from("users").select("handle").in("handle", cleaned);
  const taken = new Set((data ?? []).map((r) => String(r.handle).toLowerCase()));
  return NextResponse.json({ available: cleaned.filter((c) => !taken.has(c)) });
}

export async function PUT(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "handle:set"), 10, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let raw: unknown;
  try {
    ({ handle: raw } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (typeof raw !== "string") return NextResponse.json({ error: "handle required" }, { status: 400 });
  const handle = normalize(raw);
  if (!usable(handle)) {
    return NextResponse.json({ error: "3–20 characters: letters, numbers or _" }, { status: 400 });
  }

  const { data: me } = await supabase.from("users").select("handle").eq("id", userId).maybeSingle();
  if (!me) return NextResponse.json({ error: "No user for session" }, { status: 404 });
  if (me.handle) return NextResponse.json({ error: "You already have a username" }, { status: 409 });

  const { error } = await supabase.from("users").update({ handle }).eq("id", userId).is("handle", null);
  if (error) {
    const dup = error.code === "23505";
    return NextResponse.json(
      { error: dup ? "That name was just taken — pick another" : "Could not save" },
      { status: dup ? 409 : 500 }
    );
  }
  return NextResponse.json({ handle });
}

/** PATCH { hideFromLeaderboard } → user preference flags. */
export async function PATCH(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "user:prefs"), 20, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { hideFromLeaderboard?: unknown; adultConfirmed?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const update: { hide_from_leaderboard?: boolean; adult_confirmed_at?: string | null } = {};
  if (typeof body.hideFromLeaderboard === "boolean") update.hide_from_leaderboard = body.hideFromLeaderboard;
  // The user's own word that they are 18 or older (Kev, 2026-10-03), kept
  // with its time. Withdrawing it hides 18+ again.
  if (typeof body.adultConfirmed === "boolean") update.adult_confirmed_at = body.adultConfirmed ? new Date().toISOString() : null;
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "hideFromLeaderboard or adultConfirmed must be a boolean" }, { status: 400 });
  }

  const { error } = await supabase.from("users").update(update).eq("id", userId);
  if (error) return NextResponse.json({ error: "Could not save" }, { status: 500 });
  return NextResponse.json({
    ...("hide_from_leaderboard" in update && { hideFromLeaderboard: update.hide_from_leaderboard }),
    ...("adult_confirmed_at" in update && { adultConfirmed: update.adult_confirmed_at !== null }),
  });
}
