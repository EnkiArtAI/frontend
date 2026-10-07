/**
 * POST /api/auth/passkey/stepup/verify  { response, scope } → { token }
 *
 * Verifies the assertion against the cookie challenge + the stored credential,
 * bumps the signature counter, and mints a short-lived step-up token the
 * sensitive endpoint checks (see requireStepUp). scope binds the token to the
 * action it was issued for (e.g. "delete-work").
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { requireAuth } from "@/lib/auth";
import { rp, resolveStableUserId, readChallengeCookie, clearChallengeCookie, mintStepUpToken, isStepUpScope } from "@/lib/webauthn";

const bodySchema = z.object({
  response: z.record(z.string(), z.unknown()),
  scope: z.string().refine(isStepUpScope),
});

export async function POST(req: NextRequest) {
  let walletAddress: string;
  try {
    ({ walletAddress } = await requireAuth(req));
  } catch {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const userId = await resolveStableUserId(supabase, walletAddress);
  if (!userId) return NextResponse.json({ error: "No user for session" }, { status: 404 });

  const challenge = readChallengeCookie(req, "pk_auth_challenge", userId);
  if (!challenge) return NextResponse.json({ error: "Challenge expired — try again" }, { status: 400 });

  const credentialId = (parsed.data.response as { id?: string }).id;
  const { data: cred } = await supabase
    .from("webauthn_credentials")
    .select("credential_id, public_key, counter, transports")
    .eq("user_id", userId)
    .eq("credential_id", credentialId ?? "")
    .maybeSingle();
  if (!cred) return NextResponse.json({ error: "Unknown passkey" }, { status: 404 });

  const { rpID, origin } = rp();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: parsed.data.response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(Buffer.from(cred.public_key, "base64url")),
        counter: Number(cred.counter),
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      },
    });
  } catch {
    return NextResponse.json({ error: "Passkey verification failed" }, { status: 400 });
  }

  const res0 = () => clearChallengeCookie(NextResponse.json({ error: "Passkey verification failed" }, { status: 400 }), "pk_auth_challenge");
  if (!verification.verified) return res0();

  // Advance the counter (clone/replay protection) and stamp last use.
  await supabase
    .from("webauthn_credentials")
    .update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("credential_id", cred.credential_id);

  const token = await mintStepUpToken(userId, parsed.data.scope);
  const res = NextResponse.json({ token });
  clearChallengeCookie(res, "pk_auth_challenge");
  return res;
}
