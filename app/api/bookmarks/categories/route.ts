/**
 * The signed-in user's bookmark categories.
 *
 *   GET  → { categories: [{ id, name, count, logoUrl, createdAt }] }
 *          logoUrl = the FIRST bookmark's image (lowest position) — the
 *          category logo is always the first image (Kev, 2026-08-22).
 *   POST → { name } → { category } — creates one; a duplicate name answers
 *          409 with the existing row, so "create" from the picker can never
 *          fork a second list with the same label.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { hiddenAdultPrompts, viewer } from "@/lib/adult-content";

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const { userId, showAdult } = await viewer(supabase, req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data: cats, error } = await supabase
    .from("bookmark_categories")
    .select("id, name, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: "Bookmarks unavailable" }, { status: 503 });

  // One pass over the user's bookmarks answers every count and every logo —
  // per-category queries would be N round-trips for a sidebar panel.
  const { data: marks, error: e2 } = await supabase
    .from("bookmarks")
    .select("category_id, prompt_id, image_url, position")
    .eq("user_id", userId)
    .order("position", { ascending: true });
  if (e2) return NextResponse.json({ error: "Bookmarks unavailable" }, { status: 503 });

  // 18+ counts and shows as a logo only while the pill is on, or as the viewer's own.
  const hidden = await hiddenAdultPrompts(supabase, { userId, showAdult }, [...new Set((marks ?? []).map((m) => String(m.prompt_id)))]);
  if (!hidden) return NextResponse.json({ error: "Bookmarks unavailable" }, { status: 503 });
  const byCat = new Map<string, { count: number; logoUrl: string | null }>();
  for (const m of (marks ?? []).filter((m) => !hidden.has(String(m.prompt_id)))) {
    const cur = byCat.get(m.category_id) ?? { count: 0, logoUrl: null };
    cur.count += 1;
    if (cur.logoUrl === null && m.image_url) cur.logoUrl = m.image_url;
    byCat.set(m.category_id, cur);
  }
  return NextResponse.json({
    categories: (cats ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      count: byCat.get(c.id)?.count ?? 0,
      logoUrl: byCat.get(c.id)?.logoUrl ?? null,
      createdAt: c.created_at,
    })),
  });
}

const createSchema = z.object({ name: z.string().trim().min(1).max(60) });

export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A category needs a name (max 60 chars)" }, { status: 400 });

  const { data, error } = await supabase
    .from("bookmark_categories")
    .insert({ user_id: userId, name: parsed.data.name })
    .select("id, name, created_at")
    .single();
  if (error) {
    // Unique (user_id, name): hand back the existing category instead of an
    // opaque failure — the picker treats "already there" as success.
    const { data: existing } = await supabase
      .from("bookmark_categories")
      .select("id, name, created_at")
      .eq("user_id", userId)
      .eq("name", parsed.data.name)
      .maybeSingle();
    if (existing) return NextResponse.json({ category: existing }, { status: 409 });
    return NextResponse.json({ error: "Couldn't create the category" }, { status: 503 });
  }
  return NextResponse.json({ category: data });
}
