import { NextResponse } from "next/server";
import { isDbUnreachable, DbUnreachableError } from "@/lib/db-error";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { escapeLike } from "@/lib/db-escape";

/**
 * DB-backed access whitelist for the private-beta stage. A login with a
 * whitelisted wallet/email is granted app access by setting the same gate
 * cookie the proxy checks; everyone else is turned away. See
 * migrations/2026-07-11-access-allowlist.sql and lib/../proxy.ts.
 */
const COOKIE = "enki_team";

// The whitelist stage is active exactly when the gate code is configured — the
// same flag proxy.ts gates on. When it's unset (post-launch), everyone is in.
export function whitelistStageActive(): boolean {
  return !!process.env.TEAM_ACCESS_CODE;
}

type Supabase = ReturnType<typeof getSupabaseServerClient>;

export async function isWalletAllowed(supabase: Supabase, address: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("access_allowlist")
    .select("id")
    .eq("kind", "wallet")
    .ilike("value", escapeLike(address)) // case-insensitive, wildcards escaped
    .maybeSingle();
  // A dead host is not "not on the list" — callers turn this into a 503.
  if (isDbUnreachable(error)) throw new DbUnreachableError();
  return !!data;
}

export async function isEmailAllowed(supabase: Supabase, email: string): Promise<boolean> {
  // Emails are stored lowercased (register/login lowercase before writing), so
  // an exact eq on the lowercased value is both correct and injection-proof.
  const { data, error } = await supabase
    .from("access_allowlist")
    .select("id")
    .eq("kind", "email")
    .eq("value", email.trim().toLowerCase())
    .maybeSingle();
  if (isDbUnreachable(error)) throw new DbUnreachableError();
  return !!data;
}

/**
 * During the whitelist stage, an account that came in through the access list
 * IS a beta member (Kev, 2026-10-13). The client wall admits beta/mod/admin
 * only, so a listed wallet whose account was created at the column default
 * 'user' could log in and pick a name, and was then shown as a guest. Every
 * login that passed the list calls this; it lifts 'user' only, so a staff
 * role is never touched. Nothing once the stage is over.
 */
export async function admitAllowlisted(supabase: Supabase, userId: string): Promise<void> {
  if (!whitelistStageActive()) return;
  const { error } = await supabase.from("users").update({ role: "beta" }).eq("id", userId).eq("role", "user");
  // The login stands either way: the account browses as before until its next one.
  if (error) console.error("[allowlist] could not admit the account:", error.message);
}

// Grants app access after a whitelisted login by setting the gate cookie the
// proxy checks. No-op when the whitelist stage is off. httpOnly so page JS
// can't read it (same as /api/gate).
export function grantGateCookie(res: NextResponse): NextResponse {
  const code = process.env.TEAM_ACCESS_CODE;
  if (!code) return res;
  res.cookies.set(COOKIE, code, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}

// Takes app access back. The cookie opens every page, so a banned account
// must not keep browsing on one it got before the ban.
export function revokeGateCookie(res: NextResponse): NextResponse {
  res.cookies.set(COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
  return res;
}
