/**
 * Comments & ratings on a prompt (one table, Kev's design):
 *   pure comment / rating only / rating + comment.
 *
 *   GET  → { comments: [{ id, handle, rating, body, createdAt }], stats: { count, avgRating } }
 *   POST { rating?, body? } → 201 — session required; a user's RATING is
 *        upserted (one rating per user per prompt), plain comments stack.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { notifyEvent } from "@/lib/notifications";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { hiddenOwners } from "@/lib/hidden-owners";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";

const postSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    body: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((v) => v.rating !== undefined || v.body !== undefined, {
    message: "Provide a rating, a comment, or both",
  });

/** A database that cannot be reached is an outage (503), never "no comments yet". */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    return await readComments(ctx);
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}

async function readComments({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabaseServerClient();

  const { data: all, error } = await supabase
    .from("prompt_comments")
    .select("id, user_id, rating, body, created_at")
    .eq("prompt_id", id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (isDbUnreachable(error)) return dbUnavailableResponse();
  if (error) {
    // Table not migrated yet → empty, never a broken prompt page.
    return NextResponse.json({ comments: [], stats: { count: 0, avgRating: null } });
  }
  // A banned or deleted account's comments and ratings leave the page.
  const hidden = await hiddenOwners(supabase, (all ?? []).map((r) => String(r.user_id)));
  if (!hidden) return NextResponse.json({ comments: [], stats: { count: 0, avgRating: null } });
  const rows = (all ?? []).filter((r) => !hidden.has(String(r.user_id)));

  // Handles in one lookup (no embedding dependency).
  const userIds = [...new Set((rows ?? []).map((r) => r.user_id))];
  const handleById = new Map<string, string | null>();
  if (userIds.length) {
    const { data: users } = await supabase.from("users").select("id, handle").in("id", userIds);
    for (const u of users ?? []) handleById.set(u.id, u.handle ?? null);
  }

  const ratings = (rows ?? []).filter((r) => typeof r.rating === "number");
  return NextResponse.json({
    comments: (rows ?? []).map((r) => ({
      id: r.id,
      handle: handleById.get(r.user_id) ?? "anonymous",
      rating: r.rating ?? null,
      body: r.body ?? null,
      createdAt: r.created_at,
    })),
    stats: {
      count: rows?.length ?? 0,
      avgRating: ratings.length
        ? Math.round((ratings.reduce((s, r) => s + (r.rating as number), 0) / ratings.length) * 10) / 10
        : null,
    },
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const limit = checkRequestRateLimit(rateLimitKey(req, "prompt-comment"), 10, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const { rating, body } = parsed.data;

  const { error } = await supabase.from("prompt_comments").insert({
    prompt_id: id,
    user_id: userId,
    rating: rating ?? null,
    body: body ?? null,
  });
  if (error) {
    if (error.code === "23505" && rating !== undefined) {
      // One rating per user per prompt → update the existing one instead.
      const { error: upErr } = await supabase
        .from("prompt_comments")
        .update({ rating, ...(body !== undefined ? { body } : {}) })
        .eq("prompt_id", id)
        .eq("user_id", userId)
        .not("rating", "is", null);
      if (upErr) return NextResponse.json({ error: "Could not save rating" }, { status: 500 });
      // No notification here: this path only ever EDITS an existing rating,
      // and re-notifying would inflate the coalesced counter on every edit.
      return NextResponse.json({ ok: true, updated: true });
    }
    console.error("[prompts/comments] insert failed:", error.message);
    return NextResponse.json({ error: "Could not save" }, { status: 500 });
  }
  await notifyPromptOwner(supabase, id, userId, rating);
  return NextResponse.json({ ok: true }, { status: 201 });
}

/** Tell the prompt's creator — coalesces per prompt+day, never notifies
    yourself, and never breaks the comment flow. */
async function notifyPromptOwner(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  promptId: string,
  actorId: string,
  rating?: number
) {
  try {
    const [{ data: prompt }, { data: actor }] = await Promise.all([
      supabase.from("prompts").select("creator_id, title").eq("id", promptId).maybeSingle(),
      supabase.from("users").select("handle").eq("id", actorId).maybeSingle(),
    ]);
    if (!prompt?.creator_id || String(prompt.creator_id) === actorId) return;
    const who = actor?.handle ?? "Someone";
    const title = prompt.title ?? "your prompt";
    await notifyEvent(supabase, rating !== undefined
      ? {
          userId: String(prompt.creator_id),
          kind: "rating",
          title: `New ratings on "${title}"`,
          body: `${who} rated it ${rating}★`,
          targetType: "prompt",
          targetId: promptId,
          actorUserId: actorId,
          meta: { rating },
        }
      : {
          userId: String(prompt.creator_id),
          kind: "comment",
          title: `New comments on "${title}"`,
          body: `Latest from ${who}`,
          targetType: "prompt",
          targetId: promptId,
          actorUserId: actorId,
        });
  } catch { /* notifications are best-effort */ }
}
