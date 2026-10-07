/**
 * POST /api/auth/passkey/stepup/options → WebAuthn authentication options for a
 * step-up challenge. Session required; challenge stashed for /verify.
 */
import { NextRequest, NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { rp, resolveStableUserId, setChallengeCookie } from "@/lib/webauthn";

type Transport = "ble" | "hybrid" | "internal" | "nfc" | "usb" | "cable" | "smart-card";

export async function POST(req: NextRequest) {
  // Ban tolerant: a ban locks the marketplace, never the wallet, and moving
  // funds off a suspended account is a step-up too.
  const { wallet: walletAddress } = await resolveSessionUserWithBan(getSupabaseServerClient(), req.headers.get("X-Session-Token"));
  if (!walletAddress) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const supabase = getSupabaseServerClient();
  const userId = await resolveStableUserId(supabase, walletAddress);
  if (!userId) return NextResponse.json({ error: "No user for session" }, { status: 404 });

  const { data: creds } = await supabase
    .from("webauthn_credentials")
    .select("credential_id, transports")
    .eq("user_id", userId);
  if (!creds || creds.length === 0) {
    return NextResponse.json({ error: "No passkey registered" }, { status: 404 });
  }

  const { rpID } = rp();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: creds.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? (JSON.parse(c.transports) as Transport[]) : undefined,
    })),
  });

  const res = NextResponse.json(options);
  setChallengeCookie(res, "pk_auth_challenge", options.challenge, userId);
  return res;
}
