/**
 * The signed-in user's bookmarks.
 *
 *   GET    ?category=<id>&cursor=<position>&limit=<n>
 *          → { bookmarks: [{ id, promptId, imageUrl, position }], nextCursor }
 *          Ordered by position; cursor-paged for the panel's infinite scroll.
 *   POST   { categoryId, promptId, imageUrl? } → { bookmark }
 *          Appends at the END, so the category's first image — its logo —
 *          stays what it is unless the user reorders (Kev, 2026-08-22).
 *          The same prompt twice in one category answers 200 with the
 *          existing row: bookmarking is idempotent, never an error toast.
 *   PATCH  { id, position } → { ok } — drag & drop lands mid-gap: the client
 *          sends the midpoint of its two new neighbours.
 *   DELETE ?id=<id> → { ok }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { viewer } from "@/lib/adult-content";

const PAGE = 30;

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const { userId, showAdult } = await viewer(supabase, req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const category = req.nextUrl.searchParams.get("category");
  if (!category) return NextResponse.json({ error: "category is required" }, { status: 400 });
  const cursorRaw = req.nextUrl.searchParams.get("cursor");
  // Number(null) is 0 — an absent cursor then filtered out every row at or
  // below position 0, which top-of-list drops produce (found by review).
  const cursor = cursorRaw == null ? Number.NaN : Number(cursorRaw);
  const limit = Math.min(60, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || PAGE));

  let q = supabase
    .from("bookmarks")
    .select("id, prompt_id, image_url, position")
    .eq("user_id", userId)
    .eq("category_id", category)
    .order("position", { ascending: true })
    .limit(limit + 1); // one extra row answers "is there more?" without a count
  if (Number.isFinite(cursor)) q = q.gt("position", cursor);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: "Bookmarks unavailable" }, { status: 503 });
  const page = (data ?? []).slice(0, limit);
  // 18+ stays out while the pill is off; the cursor still walks the full page.
  let hidden = new Set<string>();
  if (!showAdult && page.length) {
    const { data: adult, error: e2 } = await supabase
      .from("prompts").select("id").in("id", page.map((b) => b.prompt_id)).eq("is_adult", true);
    if (e2) return NextResponse.json({ error: "Bookmarks unavailable" }, { status: 503 });
    hidden = new Set((adult ?? []).map((p) => String(p.id)));
  }
  return NextResponse.json({
    bookmarks: page.filter((b) => !hidden.has(String(b.prompt_id))).map((b) => ({ id: b.id, promptId: b.prompt_id, imageUrl: b.image_url, position: b.position })),
    nextCursor: (data ?? []).length > limit ? page[page.length - 1]?.position ?? null : null,
  });
}

const addSchema = z.object({
  categoryId: z.string().uuid(),
  promptId: z.string().uuid(),
  imageUrl: z.string().url().max(2048).optional(),
});

export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = addSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "categoryId and promptId are required" }, { status: 400 });
  const { categoryId, promptId, imageUrl } = parsed.data;

  // The category must be the caller's own — a foreign id must not file
  // bookmarks into someone else's list.
  const { data: cat } = await supabase
    .from("bookmark_categories")
    .select("id")
    .eq("id", categoryId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!cat) return NextResponse.json({ error: "No such category" }, { status: 404 });

  const { data: last } = await supabase
    .from("bookmarks")
    .select("position")
    .eq("category_id", categoryId)
    .order("position", { ascending: false })
    .limit(1);
  const position = (last?.[0]?.position ?? 0) + 1;

  const { data, error } = await supabase
    .from("bookmarks")
    .insert({ user_id: userId, category_id: categoryId, prompt_id: promptId, image_url: imageUrl ?? null, position })
    .select("id, prompt_id, image_url, position")
    .single();
  if (error) {
    const { data: existing } = await supabase
      .from("bookmarks")
      .select("id, prompt_id, image_url, position")
      .eq("category_id", categoryId)
      .eq("prompt_id", promptId)
      .maybeSingle();
    if (existing) {
      return NextResponse.json({ bookmark: { id: existing.id, promptId: existing.prompt_id, imageUrl: existing.image_url, position: existing.position } });
    }
    return NextResponse.json({ error: "Couldn't save the bookmark" }, { status: 503 });
  }
  return NextResponse.json({ bookmark: { id: data.id, promptId: data.prompt_id, imageUrl: data.image_url, position: data.position } });
}

const moveSchema = z.object({ id: z.string().uuid(), position: z.number().finite() });

export async function PATCH(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = moveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "id and position are required" }, { status: 400 });

  const { error } = await supabase
    .from("bookmarks")
    .update({ position: parsed.data.position })
    .eq("id", parsed.data.id)
    .eq("user_id", userId); // ownership is part of the WHERE, not a prior read
  if (error) return NextResponse.json({ error: "Couldn't move the bookmark" }, { status: 503 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id || !z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { error } = await supabase.from("bookmarks").delete().eq("id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: "Couldn't remove the bookmark" }, { status: 503 });
  return NextResponse.json({ ok: true });
}
