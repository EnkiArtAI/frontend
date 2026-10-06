import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { requireStepUp } from "@/lib/webauthn";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
