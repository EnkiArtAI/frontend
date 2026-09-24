/**
 * Social handles shown on the profile (user_socials). Instagram is NOT a
 * login (Kev, 2026-09-24: no usable login API), it is a handle here.
 *
 *   GET                                      → { socials: [{ provider, handle, profileUrl }] }
 *   POST   { provider: "instagram", handle }  → { provider, handle, profileUrl }
 *   DELETE { provider }                       → { removed }
 *
 * Live columns (probed 2026-09-24): id, user_id, provider, handle,
 * profile_url, verified, verified_at, proof_method, is_public, created_at,
 * updated_at; user_socials_provider_check accepts 'instagram'. No unique key
 * on (user_id, provider) is known, so the write is select, then update or insert.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";

const PROFILE_URL = { instagram: (h: string) => `https://instagram.com/${h}` } as const;
const providerSchema = z.enum(["instagram"]);
// Instagram usernames: letters, digits, dots and underscores, up to 30.
const HANDLE = /^[a-z0-9._]{1,30}$/;

async function me(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  return { supabase, userId };
}

export async function GET(req: NextRequest) {
  try {
    const { supabase, userId } = await me(req);
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const { data, error } = await supabase.from("user_socials").select("provider, handle, profile_url").eq("user_id", userId);
    if (error) throw error;
    return NextResponse.json({ socials: (data ?? []).map((s) => ({ provider: s.provider, handle: s.handle, profileUrl: s.profile_url })) });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}

export async function POST(req: NextRequest) {
  const parsed = z.object({ provider: providerSchema, handle: z.string().max(64) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  const { provider } = parsed.data;
  const handle = parsed.data.handle.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE.test(handle)) return NextResponse.json({ error: "That does not look like an Instagram username" }, { status: 400 });
  const profileUrl = PROFILE_URL[provider](handle);
  try {
    const { supabase, userId } = await me(req);
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const { data: existing, error: lookupErr } = await supabase
      .from("user_socials").select("id").eq("user_id", userId).eq("provider", provider).limit(1);
    if (lookupErr) throw lookupErr;
    const row = { handle, profile_url: profileUrl, updated_at: new Date().toISOString() };
    const { error } = existing?.[0]
      ? await supabase.from("user_socials").update(row).eq("id", existing[0].id)
      : await supabase.from("user_socials").insert({ user_id: userId, provider, ...row });
    if (error) throw error;
    return NextResponse.json({ provider, handle, profileUrl });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}

export async function DELETE(req: NextRequest) {
  const parsed = z.object({ provider: providerSchema }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  try {
    const { supabase, userId } = await me(req);
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const { error } = await supabase.from("user_socials").delete().eq("user_id", userId).eq("provider", parsed.data.provider);
    if (error) throw error;
    return NextResponse.json({ removed: parsed.data.provider });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}
