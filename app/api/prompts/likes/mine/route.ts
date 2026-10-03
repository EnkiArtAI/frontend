/**
 * The signed-in user's OWN liked prompts — the private "Likes" tab on their
 * profile (Kev, 2026-08-23: visible for oneself, never for others; the
 * privacy is structural — the list is derived from the SESSION, so nobody
 * can request anyone else's).
 *
 *   GET → { likes: [{ promptId, title, imageUrl, likedAt }] }  (newest first)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { viewer } from "@/lib/adult-content";

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const { userId, showAdult } = await viewer(supabase, req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data: rows, error } = await supabase
    .from("reactions")
    .select("target_uuid, created_at")
    .eq("user_id", userId)
    .eq("target_type", "prompt")
    .eq("reaction_type", "like")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    console.warn("[likes/mine] reactions query failed:", error.message);
    return NextResponse.json({ error: "Likes unavailable" }, { status: 503 });
  }
  if (!rows?.length) return NextResponse.json({ likes: [] });

  const ids = rows.map((r) => r.target_uuid);
  const { data: prompts, error: e2 } = await supabase
    .from("prompts")
    .select("id, title, showcase_images, is_adult")
    .in("id", ids);
  if (e2) {
    console.warn("[likes/mine] prompts query failed:", e2.message);
    return NextResponse.json({ error: "Likes unavailable" }, { status: 503 });
  }
  const byId = new Map((prompts ?? []).map((p) => [String(p.id), p]));
  return NextResponse.json({
    likes: rows
      .map((r) => {
        const p = byId.get(String(r.target_uuid));
        if (!p) return null; // the prompt was deleted — its like has nothing to show
        if (p.is_adult && !showAdult) return null; // 18+ stays out while the pill is off
        const imgs = Array.isArray(p.showcase_images) ? (p.showcase_images as unknown[]) : [];
        const first = imgs.find((u) => typeof u === "string") as string | undefined;
        return { promptId: String(p.id), title: String(p.title ?? "Untitled"), imageUrl: first ?? null, likedAt: r.created_at };
      })
      .filter(Boolean),
  });
}
