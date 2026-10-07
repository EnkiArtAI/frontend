/**
 * What every password login checks before it opens a session, and how it
 * opens one. Shared by the login and an invited account's first login, so
 * neither can skip a check the other makes.
 */
import { NextRequest, NextResponse } from "next/server";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { mintUserSession } from "@/lib/user-session";
import { activeBanFor } from "@/lib/session-user";
import { whitelistStageActive, isEmailAllowed, grantGateCookie } from "@/lib/allowlist";
import { getClientIp, hashIp, isIpBanned } from "@/lib/ip-hash";

type Supabase = ReturnType<typeof getSupabaseServerClient>;

/** A refusal for this login, or null with the caller's IP hash. The access
    list answers with the generic 401, so it is no oracle for accounts. */
export async function loginRefusal(
  req: NextRequest,
  supabase: Supabase,
  email: string,
): Promise<{ refusal: NextResponse; ipHash?: undefined } | { refusal: null; ipHash: string | null }> {
  let allowed = true;
  try {
    allowed = !whitelistStageActive() || (await isEmailAllowed(supabase, email));
  } catch (e) {
    if (isDbUnreachable(e)) return { refusal: dbUnavailableResponse() };
    throw e;
  }
  if (!allowed) return { refusal: NextResponse.json({ error: "Wrong login or password" }, { status: 401 }) };

  const ipHash = hashIp(getClientIp(req));
  if (await isIpBanned(supabase, ipHash)) {
    return { refusal: NextResponse.json({ error: "Access from this network is blocked." }, { status: 403 }) };
  }
  return { refusal: null, ipHash };
}

/** Opens the session. Banned users still get one: it only opens /api/ban/*
    (status, appeal, funds), and the banned flag routes the client to /banned.
    The gate cookie grants app access during the whitelist stage. */
export async function openLoginSession(supabase: Supabase, userId: string, email: string, ipHash: string | null): Promise<NextResponse> {
  const banned = !!(await activeBanFor(supabase, userId));
  const session = await mintUserSession(userId, ipHash);
  return grantGateCookie(NextResponse.json({ email, ...session, ...(banned ? { banned: true } : {}) }));
}
