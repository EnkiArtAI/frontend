/**
 * Comments & reviews on a prompt (one table, Kev's design): a comment is
 * text from anyone signed in; a review carries one of the reviewer's own
 * generated images of the prompt (Kev, 2026-10-13: "reviews = comments but
 * with a generated image"), with a rating and text if they like.
 *
 *   GET  → { comments: [{ id, handle, rating, body, imageUrl, createdAt }], stats: { count, avgRating } }
 *   POST { rating?, body?, imageId? } → 201 — session required; imageId must
 *        be one of the session user's generated_images of this prompt; a
 *        user's RATING is upserted (one rating per user per prompt), plain
 *        comments stack.
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
    imageId: z.string().uuid().optional(),
  })
  .refine((v) => v.rating !== undefined || v.body !== undefined || v.imageId !== undefined, {
    message: "Provide a rating, a comment, an image, or any of them together",
  });

/** The picture a review shows: the row's current preview, nothing once the image is gone. */
const imageUrlOf = (img: { preview_url: string | null; storage_url: string | null; deleted_at: string | null } | undefined) =>
  img && !img.deleted_at ? img.preview_url ?? img.storage_url ?? null : null;

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

  type Row = { id: string; user_id: string; rating: number | null; body: string | null; image_id?: string | null; created_at: string };
  const read = (columns: string) => supabase
    .from("prompt_comments")
    .select(columns)
    .eq("prompt_id", id)
    // Filter accounts and current bans in SQL before the visible-comment cap.
    .is("author.deleted_at", null)
    .or("account_status.is.null,account_status.eq.active", { referencedTable: "author" })
    .is("author.active_bans.lifted_at", null)
    .or("expires_at.is.null,expires_at.gt." + new Date().toISOString(), { referencedTable: "author.active_bans" })
    .is("author.active_bans", null)
    .order("created_at", { ascending: false })
    .limit(100);
  const author = "author:users!user_id!inner(active_bans:bans!user_id())";
  let { data: all, error } = await read(`id, user_id, rating, body, image_id, created_at, ${author}`);
  // No image_id column yet (42703): the read before migrations/2026-10-13-prompt-comments-image.sql ran.
  if (error?.code === "42703") ({ data: all, error } = await read(`id, user_id, rating, body, created_at, ${author}`));
  if (isDbUnreachable(error)) return dbUnavailableResponse();
  if (error) {
    // Table not migrated yet → empty, never a broken prompt page.
    return NextResponse.json({ comments: [], stats: { count: 0, avgRating: null } });
  }
  // Recheck visibility before exposing rows, including a ban applied after the query.
  const fetched = (all ?? []) as unknown as Row[];
  const hidden = await hiddenOwners(supabase, fetched.map((r) => String(r.user_id)));
  if (!hidden) return NextResponse.json({ comments: [], stats: { count: 0, avgRating: null } });
  const rows = fetched.filter((r) => !hidden.has(String(r.user_id)));

  // Handles in one lookup (no embedding dependency).
  const userIds = [...new Set((rows ?? []).map((r) => r.user_id))];
  const handleById = new Map<string, string | null>();
  if (userIds.length) {
    const { data: users, error: usersError } = await supabase.from("users").select("id, handle").in("id", userIds);
    if (isDbUnreachable(usersError)) return dbUnavailableResponse();
    for (const u of users ?? []) handleById.set(u.id, u.handle ?? null);
  }

  // The reviews' images, by id: their current previews, one read for all of them.
  const imageIds = [...new Set(rows.flatMap((r) => (typeof r.image_id === "string" ? [r.image_id] : [])))];
  const imageById = new Map<string, { preview_url: string | null; storage_url: string | null; deleted_at: string | null }>();
  if (imageIds.length) {
    const { data: images, error: imagesError } = await supabase.from("generated_images").select("id, preview_url, storage_url, deleted_at").in("id", imageIds);
    if (isDbUnreachable(imagesError)) return dbUnavailableResponse();
    for (const im of images ?? []) imageById.set(im.id, im);
  }

  const ratings = (rows ?? []).filter((r) => typeof r.rating === "number");
  return NextResponse.json({
    comments: (rows ?? []).map((r) => ({
      id: r.id,
      handle: handleById.get(r.user_id) ?? "anonymous",
      rating: r.rating ?? null,
      body: r.body ?? null,
      imageUrl: typeof r.image_id === "string" ? imageUrlOf(imageById.get(r.image_id)) : null,
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
  const { rating, body, imageId } = parsed.data;

  // A review shows one of the reviewer's OWN renders of THIS prompt: never an
  // upload, never a deleted one, never anyone else's (the id is checked, not
  // trusted).
  if (imageId) {
    const { data: image, error: imageError } = await supabase
      .from("generated_images")
      .select("id")
      .eq("id", imageId)
      .eq("user_id", userId)
      .eq("prompt_id", id)
      .eq("is_uploaded", false)
      .is("deleted_at", null)
      .maybeSingle();
    if (isDbUnreachable(imageError)) return dbUnavailableResponse();
    if (!image) return NextResponse.json({ error: "A review shows one of your own images made with this prompt" }, { status: 400 });
  }

  // image_id only when there is one: a comment still lands before migrations/2026-10-13-prompt-comments-image.sql ran.
  const { error } = await supabase.from("prompt_comments").insert({
    prompt_id: id,
    user_id: userId,
    rating: rating ?? null,
    body: body ?? null,
    ...(imageId ? { image_id: imageId } : {}),
  });
  if (error) {
    if (error.code === "23505" && rating !== undefined) {
      // One rating per user per prompt → update the existing one instead.
      const { error: upErr } = await supabase
        .from("prompt_comments")
        .update({ rating, ...(body !== undefined ? { body } : {}), ...(imageId !== undefined ? { image_id: imageId } : {}) })
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
