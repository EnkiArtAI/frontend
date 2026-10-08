import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isListed } from "@/lib/prompt-visibility";
import { mayShowAdult, viewer } from "@/lib/adult-content";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { hiddenOwners } from "@/lib/hidden-owners";

/**
 * What people made with a prompt and chose to show (Kev, 2026-10-08). Every
 * generation is private until its owner makes it public, in My Gallery or in
 * the image UI's history; uploads are never public. Only a listed prompt shows
 * them, and 18+ images only to a viewer who may see 18+.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 24;

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid prompt id" }, { status: 400 });
  try {
    const supabase = getSupabaseServerClient();
    const { data: prompt, error } = await supabase
      .from("prompts")
      .select("id, creator_id, is_listed, listing_status, deleted_at, is_adult")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    const v = await viewer(supabase, req);
    // A prompt that is not on sale, or 18+ to someone who may not see it, shows nothing.
    if (!prompt || !isListed(prompt) || (prompt.is_adult && !mayShowAdult(v, prompt.creator_id))) {
      return NextResponse.json({ images: [] });
    }
    let images = supabase
      .from("generated_images")
      .select("id, user_id, storage_url, preview_url, thumbnail_url, created_at")
      .eq("prompt_id", id)
      .eq("visibility", "public")
      .eq("is_uploaded", false)
      .is("deleted_at", null);
    if (!v.showAdult) images = images.eq("is_adult", false);
    const { data, error: readError } = await images.order("created_at", { ascending: false }).limit(LIMIT);
    if (readError) throw readError;
    // Images of a banned or deleted account leave the row, as from every public
    // read; a hidden creator's prompt shows none.
    const hidden = await hiddenOwners(supabase, [String(prompt.creator_id ?? ""), ...(data ?? []).map((r) => String(r.user_id ?? ""))]);
    if (!hidden) return dbUnavailableResponse();
    if (hidden.has(String(prompt.creator_id))) return NextResponse.json({ images: [] });
    return NextResponse.json({
      images: (data ?? []).filter((r) => !hidden.has(String(r.user_id))).map((r) => ({
        id: r.id,
        url: r.preview_url ?? r.storage_url,
        thumbnailUrl: r.thumbnail_url ?? r.preview_url ?? r.storage_url,
        createdAt: r.created_at,
      })),
    });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("prompt images read failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not load the images" }, { status: 500 });
  }
}
