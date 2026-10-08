/**
 * POST /api/auth/passkey/register/options → WebAuthn registration options.
 * Session required. Challenge is stashed in an httpOnly cookie for /verify.
 */
import { NextRequest, NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { authRefusal, requireAuth } from "@/lib/auth";
import { RP_NAME, rp, resolveStableUserId, setChallengeCookie, requireAddFactor } from "@/lib/webauthn";

type Transport = "ble" | "hybrid" | "internal" | "nfc" | "usb" | "cable" | "smart-card";

export async function POST(req: NextRequest) {
  let walletAddress: string;
  try {
    ({ walletAddress } = await requireAuth(req));
  } catch (e) {
    return authRefusal(e, "Not signed in");
  }

  const supabase = getSupabaseServerClient();
  const userId = await resolveStableUserId(supabase, walletAddress);
  if (!userId) return NextResponse.json({ error: "No user for session" }, { status: 404 });
  // Without this gate a stolen session registered its own passkey and then
  // owned every step-up. /verify needs this route's challenge cookie.
  const blocked = await requireAddFactor(req, userId);
  if (blocked) return blocked;

  const { data: cred } = await supabase.from("password_credentials").select("email").eq("user_id", userId).maybeSingle();
  const { data: existing } = await supabase
    .from("webauthn_credentials")
    .select("credential_id, transports")
    .eq("user_id", userId);

  const { rpID } = rp();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: cred?.email ?? "enki-user",
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: (existing ?? []).map((c) => ({
      id: c.credential_id,
      transports: c.transports ? (JSON.parse(c.transports) as Transport[]) : undefined,
    })),
    // required: this is a 2FA factor — the authenticator must verify the user
    // (biometric/PIN), not merely detect presence.
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });

  const res = NextResponse.json(options);
  setChallengeCookie(res, "pk_reg_challenge", options.challenge, userId);
  return res;
}
