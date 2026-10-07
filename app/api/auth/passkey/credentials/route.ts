/**
 * Passkey (2FA device) management for the signed-in user.
 *
 *   GET    → { credentials: [{ id, deviceLabel, createdAt, lastUsedAt }] }
 *   DELETE { id } → removes one of the user's own passkeys
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { requireStepUp } from "@/lib/webauthn";

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data } = await supabase
    .from("webauthn_credentials")
    .select("id, device_label, created_at, last_used_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  return NextResponse.json({
    credentials: (data ?? []).map((c) => ({
      id: c.id,
      deviceLabel: c.device_label,
      createdAt: c.created_at,
      lastUsedAt: c.last_used_at,
    })),
  });
}

export async function DELETE(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let id: unknown;
  try {
    ({ id } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (typeof id !== "string" || !id) return NextResponse.json({ error: "id required" }, { status: 400 });
  // A factor is removed only with a factor: a stolen session could otherwise
  // strip the owner's passkey before doing anything else.
  const blocked = await requireStepUp(req, userId, `remove-factor:${id}`, { mandatory: true });
  if (blocked) return blocked;
  const { error } = await supabase.from("webauthn_credentials").delete().eq("id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: "Could not remove" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
