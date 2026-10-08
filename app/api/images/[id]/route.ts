import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { requireStepUp } from "@/lib/webauthn";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { hideAdult, viewer } from "@/lib/adult-content";
import { hiddenOwners } from "@/lib/hidden-owners";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISIBILITY = new Set(["public", "private"]); // the live CHECK's two values (probed 2026-10-07)

/**
 * One published image, for anyone (SHR-1). Images are recorded private; only
 * what its owner published is served, uploads not before the image check
 * exists, 18+ only to a confirmed adult with the pill on.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid image id" }, { status: 400 });
  try {
    const supabase = getSupabaseServerClient();
    const published = supabase
      .from("generated_images")
      .select("id, user_id, storage_url, preview_url, thumbnail_url, width, height, prompt_id, created_at")
      .eq("id", id)
      .eq("visibility", "public")
      .eq("is_uploaded", false)
      .is("deleted_at", null);
    const { data, error } = await hideAdult(published, await viewer(supabase, req)).maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Image not found" }, { status: 404 });
    // A banned or deleted account's image is no longer public.
    const hidden = await hiddenOwners(supabase, [String(data.user_id ?? "")]);
    if (!hidden) return dbUnavailableResponse();
    if (hidden.has(String(data.user_id))) return NextResponse.json({ error: "Image not found" }, { status: 404 });
    return NextResponse.json({
      id: data.id,
      imageUrl: data.storage_url,
      previewUrl: data.preview_url ?? null,
      thumbnailUrl: data.thumbnail_url ?? null,
      width: data.width ?? null,
      height: data.height ?? null,
      promptId: data.prompt_id ?? null,
      createdAt: data.created_at,
    });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("image read failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not read the image" }, { status: 500 });
  }
}

/** Publish or unpublish one of the caller's own images: { visibility: "public" | "private" }. */
export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid image id" }, { status: 400 });
  const visibility = (await req.json().catch(() => null))?.visibility;
  if (!VISIBILITY.has(visibility)) {
    return NextResponse.json({ error: 'visibility must be "public" or "private"' }, { status: 400 });
  }
  try {
    const supabase = getSupabaseServerClient();
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Sign in to publish images" }, { status: 401 });
    let change = supabase
      .from("generated_images")
      .update({ visibility }, { count: "exact" })
      .eq("id", id)
      .eq("user_id", userId)
      .is("deleted_at", null);
    // An upload is published only once the image check exists; until then a
    // reader filtering on visibility alone would show it unchecked.
    if (visibility === "public") change = change.eq("is_uploaded", false);
    const { error, count } = await change;
    if (error) throw error;
    if (!count) return NextResponse.json({ error: "Image not found" }, { status: 404 });
    return NextResponse.json({ id, visibility });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("image visibility change failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not change the image" }, { status: 500 });
  }
}

/**
 * Delete one image of the caller's gallery. The gallery lists
 * generated_images ids; the old DELETE /api/generations/[id] took that id to
 * the generations table and scoped it with ilike on a uuid column, so every
 * delete was a 500. Soft delete: the row keeps its payment and prompt links,
 * and every gallery read already skips deleted_at.
 */
export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid image id" }, { status: 400 });
  try {
    const supabase = getSupabaseServerClient();
    // Images are recorded under the session's users.id (record.ts, gallery
    // upload), so that id is the owner. A banned session resolves to nobody.
    const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!userId) return NextResponse.json({ error: "Sign in to delete images" }, { status: 401 });

    // Step-up 2FA for "delete work", enforced once the user enrolled a
    // passkey; the scope names this image so one tap deletes only it.
    const blocked = await requireStepUp(req, userId, `delete-work:${id}`);
    if (blocked) return blocked;

    const { error, count } = await supabase
      .from("generated_images")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", id)
      .eq("user_id", userId)
      .is("deleted_at", null);
    if (error) throw error;
    // Missing, already deleted or someone else's: one answer, no ownership oracle.
    if (!count) return NextResponse.json({ error: "Image not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("image delete failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not delete the image" }, { status: 500 });
  }
}
