/**
 * "Refer a prompt": a signed-in user sends in a link to a post, a moderator
 * rebuilds it as a prompt (Kev, 2026-10-05: the dialog stores the link in the
 * admin queue).
 *
 *   POST { url }  → 201 { ok: true }          the link is in the queue
 *   GET           → { referrals: [...] }      the caller's own links
 *
 * The queue is hunt_submissions, which the admin panel's "Pending imports"
 * reads. Live table, probed 2026-10-05: hunter_user_id (users.id),
 * source_url, normalized_source_url and source_platform are required;
 * source_platform accepts x, instagram, tiktok, other; status defaults to
 * pending and accepts pending, approved, rejected, duplicate; submitted_at
 * defaults to now, and minted_prompt_id (prompts.id) is empty until a
 * moderator has turned the link into a prompt.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { parseReferralLink } from "@/lib/referral-link";

const ALREADY = "This link was already sent in.";

/** The account behind the request; a suspended one sends nothing in and reads nothing. */
async function caller(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const { userId, ban } = await resolveSessionUserWithBan(supabase, req.headers.get("X-Session-Token"));
  return { supabase, userId: ban ? null : userId };
}

export async function POST(req: NextRequest) {
  try {
    const { supabase, userId } = await caller(req);
    if (!userId) return NextResponse.json({ error: "Sign in to refer a prompt." }, { status: 401 });

    const limit = checkRequestRateLimit(rateLimitKey(req, "referrals:submit", userId), 10, 10 * 60_000);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
    const link = parseReferralLink(body?.url);
    if (!link) return NextResponse.json({ error: "Enter the full link to the post, starting with https://" }, { status: 400 });

    // One entry per post, whoever sent it first and however the link was copied
    // (lib/referral-link: by the post's id where the site has one).
    const { data: known, error: lookupError } = await supabase
      .from("hunt_submissions")
      .select("id")
      .eq("normalized_source_url", link.normalized)
      .limit(1);
    if (lookupError) throw lookupError;
    if (known?.length) return NextResponse.json({ error: ALREADY }, { status: 409 });

    const { error } = await supabase.from("hunt_submissions").insert({
      hunter_user_id: userId,
      source_url: link.url,
      normalized_source_url: link.normalized,
      source_platform: link.platform,
    });
    // Two people sending the same post at once: the database keeps one.
    if (error?.code === "23505") return NextResponse.json({ error: ALREADY }, { status: 409 });
    if (error) throw error;

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[referrals] submit failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "The link could not be sent in. Try again." }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { supabase, userId } = await caller(req);
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const { data, error } = await supabase
      .from("hunt_submissions")
      .select("id, source_url, source_platform, status, minted_prompt_id, submitted_at")
      .eq("hunter_user_id", userId)
      .order("submitted_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return NextResponse.json({
      referrals: (data ?? []).map((r) => ({
        id: r.id,
        url: r.source_url,
        platform: r.source_platform,
        status: r.status,
        promptId: r.minted_prompt_id ?? null,
        submittedAt: r.submitted_at,
      })),
    });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[referrals] list failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Your referrals could not be loaded." }, { status: 500 });
  }
}
