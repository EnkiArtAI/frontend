/**
 * Step-up with a code factor (the passkey keeps its own WebAuthn routes under
 * /api/auth/passkey/stepup).
 *
 *   GET                                   -> { factors: ["passkey" | "totp" | "email"], emailCodes }
 *     (emailCodes: whether an email code can be a factor here; never for a password account)
 *   POST { scope, factor, code }          -> { token } for X-StepUp-Token
 *
 * Ban tolerant on purpose: a ban locks the marketplace, never the wallet, and
 * moving funds off a suspended account is a step-up too.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { checkCode, enrolledFactors, isPasswordAccount } from "@/lib/mfa";
import { isStepUpScope, mintStepUpToken } from "@/lib/webauthn";

async function sessionUser(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const { userId } = await resolveSessionUserWithBan(supabase, req.headers.get("X-Session-Token"));
  return { supabase, userId };
}

export async function GET(req: NextRequest) {
  try {
    const { supabase, userId } = await sessionUser(req);
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const [factors, password] = await Promise.all([enrolledFactors(supabase, userId), isPasswordAccount(supabase, userId)]);
    return NextResponse.json({ factors, emailCodes: !password });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    return NextResponse.json({ error: "Could not read your security settings" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { scope?: unknown; factor?: unknown; code?: unknown } | null;
  if (!isStepUpScope(body?.scope)) return NextResponse.json({ error: "Unknown scope" }, { status: 400 });
  if (body?.factor !== "totp" && body?.factor !== "email") return NextResponse.json({ error: "factor must be totp or email" }, { status: 400 });
  if (typeof body.code !== "string") return NextResponse.json({ error: "code required" }, { status: 400 });
  try {
    const { supabase, userId } = await sessionUser(req);
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    // Only a factor that counts steps up: an email code is none for a password account.
    if (!(await enrolledFactors(supabase, userId)).includes(body.factor)) {
      return NextResponse.json({ error: "That factor is not set up" }, { status: 404 });
    }
    const result = await checkCode(supabase, userId, body.factor, body.code);
    if (result === "ok") return NextResponse.json({ token: await mintStepUpToken(userId, body.scope) });
    if (result === "none") return NextResponse.json({ error: "That factor is not set up" }, { status: 404 });
    if (result === "locked") return NextResponse.json({ error: "Too many wrong codes. This factor is locked for now; try another one or wait." }, { status: 429 });
    if (result === "busy") return NextResponse.json({ error: "Another check is running, try again" }, { status: 409 });
    return NextResponse.json({ error: "Wrong code" }, { status: 401 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[stepup] code check failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not check the code" }, { status: 500 });
  }
}
