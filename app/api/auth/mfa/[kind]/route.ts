/**
 * Setting up and removing a code factor (kind = totp | email).
 *
 *   POST   totp               -> { secret, uri } for the authenticator app's QR code
 *   POST   email { email }    -> { sent } a code to that address
 *   DELETE                    -> { removed }
 *
 * Either one is confirmed with POST /api/auth/mfa/[kind]/confirm { code }.
 * Adding is gated by requireAddFactor (a fresh login for the first factor, a
 * step-up after that), removing by a step-up with the factor itself.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { beginEmail, beginTotp, type FactorKind } from "@/lib/mfa";
import { requireAddFactor, requireStepUp } from "@/lib/webauthn";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
type Ctx = { params: Promise<{ kind: string }> };

async function context(req: NextRequest, ctx: Ctx) {
  const { kind } = await ctx.params;
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  return { kind: kind === "totp" || kind === "email" ? (kind as FactorKind) : null, supabase, userId };
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { kind, supabase, userId } = await context(req, ctx);
    if (!kind) return NextResponse.json({ error: "Unknown factor" }, { status: 404 });
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { email?: unknown };
    const address = typeof body.email === "string" ? body.email.trim() : "";
    if (kind === "email" && (address.length > 254 || !EMAIL.test(address))) return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });

    const blocked = await requireAddFactor(req, userId);
    if (blocked) return blocked;

    if (kind === "totp") {
      const { data: u } = await supabase.from("users").select("handle").eq("id", userId).maybeSingle();
      const started = await beginTotp(supabase, userId, String(u?.handle ?? "Enki account"));
      if (started === "exists") return NextResponse.json({ error: "An authenticator is already set up. Remove it first." }, { status: 409 });
      return NextResponse.json(started);
    }
    const sent = await beginEmail(supabase, userId, address);
    if (sent === "exists") return NextResponse.json({ error: "An email factor is already set up. Remove it first." }, { status: 409 });
    if (sent === "sent") return NextResponse.json({ sent: true });
    if (sent === "cooldown" || sent === "daily_cap") return NextResponse.json({ error: "Too many codes. Wait before asking for another." }, { status: 429 });
    return NextResponse.json({ error: "The code could not be sent" }, { status: 502 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[mfa] setup failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not set up the factor" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const { kind, supabase, userId } = await context(req, ctx);
    if (!kind) return NextResponse.json({ error: "Unknown factor" }, { status: 404 });
    if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const blocked = await requireStepUp(req, userId, `remove-factor:${kind}`, { mandatory: true });
    if (blocked) return blocked;
    const { error, count } = await supabase.from("mfa_factors").delete({ count: "exact" }).eq("user_id", userId).eq("kind", kind);
    if (error) throw error;
    if (!count) return NextResponse.json({ error: "That factor is not set up" }, { status: 404 });
    return NextResponse.json({ removed: true });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[mfa] removal failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not remove the factor" }, { status: 500 });
  }
}
