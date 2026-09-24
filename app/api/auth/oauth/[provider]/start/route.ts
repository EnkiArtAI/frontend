/**
 * GET  /api/auth/oauth/[provider]/start?next=/path   login: 302 to the provider
 * POST /api/auth/oauth/[provider]/start  (X-Session-Token)  link: { url }
 *
 * Both set the signed state cookie the callback verifies (lib/auth/oauth).
 */
import { NextRequest, NextResponse } from "next/server";
import { beginAuth, isProvider, OAuthError, STATE_COOKIE, STATE_COOKIE_PATH, STATE_TTL_S, appUrl, type Intent, type Provider } from "@/lib/auth/oauth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

type Ctx = { params: Promise<{ provider: string }> };

function withStateCookie(res: NextResponse, cookie: string): NextResponse {
  res.cookies.set(STATE_COOKIE, cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: STATE_COOKIE_PATH,
    maxAge: STATE_TTL_S,
  });
  return res;
}

async function begin(provider: Provider, intent: Intent, next: string | null) {
  try {
    return await beginAuth(provider, intent, next);
  } catch (e) {
    if (e instanceof OAuthError) return e;
    throw e;
  }
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { provider } = await ctx.params;
  if (!isProvider(provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const limit = checkRequestRateLimit(rateLimitKey(req, "auth:oauth:start:ip"), 20, 10 * 60 * 1000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const r = await begin(provider, { kind: "login" }, req.nextUrl.searchParams.get("next"));
  if (r instanceof OAuthError) return NextResponse.redirect(`${appUrl()}/auth/complete#error=${r.code}`, 302);
  return withStateCookie(NextResponse.redirect(r.url, 302), r.cookie);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { provider } = await ctx.params;
  if (!isProvider(provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const limit = checkRequestRateLimit(rateLimitKey(req, "auth:oauth:start:ip"), 20, 10 * 60 * 1000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const userId = await resolveSessionUserId(getSupabaseServerClient(), req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const r = await begin(provider, { kind: "link", userId }, req.nextUrl.searchParams.get("next"));
  if (r instanceof OAuthError) return NextResponse.json({ error: "This sign in method is not configured on this server yet." }, { status: 503 });
  return withStateCookie(NextResponse.json({ url: r.url }), r.cookie);
}
