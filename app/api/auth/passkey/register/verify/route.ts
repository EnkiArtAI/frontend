/**
 * POST /api/auth/passkey/register/verify  { response, label? } → { verified }
 * Verifies the attestation against the cookie challenge and stores the passkey.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { authRefusal, requireAuth } from "@/lib/auth";
import { rp, resolveStableUserId, readChallengeCookie, clearChallengeCookie } from "@/lib/webauthn";

const bodySchema = z.object({
  response: z.record(z.string(), z.unknown()),
  label: z.string().max(60).optional(),
});

export async function POST(req: NextRequest) {
  let walletAddress: string;
  try {
    ({ walletAddress } = await requireAuth(req));
  } catch (e) {
    return authRefusal(e, "Not signed in");
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const userId = await resolveStableUserId(supabase, walletAddress);
  if (!userId) return NextResponse.json({ error: "No user for session" }, { status: 404 });

  const challenge = readChallengeCookie(req, "pk_reg_challenge", userId);
  if (!challenge) return NextResponse.json({ error: "Challenge expired — try again" }, { status: 400 });

  const { rpID, origin } = rp();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: parsed.data.response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return NextResponse.json({ error: "Passkey verification failed" }, { status: 400 });
  }

  if (!verification.verified || !verification.registrationInfo) {
    const res = NextResponse.json({ error: "Passkey verification failed" }, { status: 400 });
    clearChallengeCookie(res, "pk_reg_challenge");
    return res;
  }

  const { credential } = verification.registrationInfo;
  const { error } = await supabase.from("webauthn_credentials").insert({
    user_id: userId,
    credential_id: credential.id,
    public_key: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: credential.transports ? JSON.stringify(credential.transports) : null,
    device_label: parsed.data.label ?? null,
  });
  if (error) {
    // 23505 = this credential is already registered; treat as success (idempotent).
    if (error.code !== "23505") {
      console.error("[passkey/register] insert failed:", error.message);
      return NextResponse.json({ error: "Could not save passkey" }, { status: 500 });
    }
  }

  const res = NextResponse.json({ verified: true });
  clearChallengeCookie(res, "pk_reg_challenge");
  return res;
}
