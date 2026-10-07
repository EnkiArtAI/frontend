/**
 * Step-up with a code factor (the passkey keeps its own WebAuthn routes under
 * /api/auth/passkey/stepup).
 *
 *   GET                                   -> { factors: ["passkey" | "totp" | "email"] }
 *   POST { scope, factor, code }          -> { token } for X-StepUp-Token
 *
 * Ban tolerant on purpose: a ban locks the marketplace, never the wallet, and
 * moving funds off a suspended account is a step-up too.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { checkCode, enrolledFactors } from "@/lib/mfa";
import { isStepUpScope, mintStepUpToken, afterStepUp } from "@/lib/webauthn";

async function sessionUser(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const { userId } = await resolveSessionUserWithBan(supabase, req.headers.get("X-Session-Token"));
  return { supabase, userId };
}

export async function GET(req: NextRequest) {
  try {
    const { supabase, userId } = await sessionUser(req);
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    return NextResponse.json({ factors: await enrolledFactors(supabase, userId) });
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
    const result = await checkCode(supabase, userId, body.factor, body.code);
    if (result === "ok") {
      try {
        await afterStepUp(supabase, req.headers.get("X-Session-Token"), userId, body.scope);
      } catch {
        // The code is spent by now: say so, or a retry with it reads as a wrong guess.
        return NextResponse.json({ error: "Could not unlock the wallet. Get a new code and try again." }, { status: 503 });
      }
      return NextResponse.json({ token: await mintStepUpToken(userId, body.scope) });
    }
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
