/**
 * GET /api/auth/oauth/[provider]/callback?code=&state=
 *
 * Verifies the state cookie, exchanges the code, verifies the identity with
 * the provider, resolves it to a user (lib/auth/oauth) and mints the ordinary
 * app session. The token leaves in the URL FRAGMENT of /auth/complete, never
 * in a query string, so it reaches neither server logs nor referrers. Every
 * answer clears the state cookie: it is single use.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  appUrl,
  completeAuth,
  isProvider,
  MissingTableError,
  OAuthError,
  readState,
  resolveIdentity,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
  type OAuthErrorCode,
} from "@/lib/auth/oauth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { mintUserSession } from "@/lib/user-session";
import { grantGateCookie } from "@/lib/allowlist";
import { getClientIp, hashIp, isIpBanned } from "@/lib/ip-hash";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

type Ctx = { params: Promise<{ provider: string }> };

function done(res: NextResponse): NextResponse {
  res.cookies.set(STATE_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
  return res;
}
const complete = (fragment: Record<string, string>) =>
  done(NextResponse.redirect(`${appUrl()}/auth/complete#${new URLSearchParams(fragment)}`, 302));
const refuse = (code: OAuthErrorCode) => complete({ error: code });

export async function GET(req: NextRequest, ctx: Ctx) {
  const { provider } = await ctx.params;
  if (!isProvider(provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const limit = checkRequestRateLimit(rateLimitKey(req, "auth:oauth:callback:ip"), 20, 10 * 60 * 1000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const claims = await readState(req.cookies.get(STATE_COOKIE)?.value, provider);
  const q = req.nextUrl.searchParams;
  if (!claims || !q.get("state") || q.get("state") !== claims.state) return refuse("state_mismatch");
  const code = q.get("code");
  if (!code) return refuse("provider_error"); // the user cancelled, or the provider sent ?error=

  const supabase = getSupabaseServerClient();
  const ipHash = hashIp(getClientIp(req));
  try {
    if (await isIpBanned(supabase, ipHash)) return refuse("network_blocked");
    const identity = await completeAuth(claims, code);
    const { userId, banned, allowlisted } = await resolveIdentity(supabase, identity, claims.intent);
    const session = await mintUserSession(userId, ipHash);
    const res = complete({
      token: session.token,
      next: claims.next,
      ...(identity.email ? { email: identity.email } : {}),
      ...(banned ? { banned: "1" } : {}),
    });
    // Gate cookie only for an allowlisted, unbanned login (link intents keep
    // whatever the session already had).
    return allowlisted ? grantGateCookie(res) : res;
  } catch (e) {
    if (e instanceof OAuthError) return refuse(e.code);
    if (e instanceof MissingTableError) {
      return done(NextResponse.json(
        { error: `Sign in with a provider needs the ${e.table} table. Run migrations/2026-09-24-auth-identities.sql first.` },
        { status: 503 },
      ));
    }
    if (isDbUnreachable(e)) return done(dbUnavailableResponse());
    console.error(`[oauth/${provider}] callback failed:`, e instanceof Error ? e.message : e);
    return refuse("provider_error");
  }
}
