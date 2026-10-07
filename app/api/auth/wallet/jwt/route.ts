/**
 * POST /api/auth/wallet/jwt → { jwt, userId }
 *
 * Turns our app session into the short-lived external JWT that CDP validates
 * (against /api/auth/wallet/jwks or a pasted static key) to provision the
 * user's embedded wallets. sub is ALWAYS users.id so the vendor sees a stable
 * identity whether the session is still the fresh-login bridge
 * (wallet_address = users.id) or already carries the real wallet address.
 *
 * The client feeds this to CDP via CdpProvider's customAuth.getJwt callback.
 *
 * Ban tolerant on purpose: a ban locks the marketplace, never the wallet, so
 * a suspended account still signs its sends and exports its key.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { mintWalletJwt } from "@/lib/wallet-jwt";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const token = req.headers.get("X-Session-Token");
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const supabase = getSupabaseServerClient();
  const { data: session } = await supabase
    .from("auth_sessions")
    .select("wallet_address")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let userId: string | null = UUID.test(session.wallet_address) ? session.wallet_address : null;
  if (!userId) {
    const { data: walletRow } = await supabase
      .from("user_wallets")
      .select("user_id")
      .eq("address", session.wallet_address)
      .is("removed_at", null)
      .maybeSingle();
    userId = walletRow?.user_id ?? null;
  }
  if (!userId) return NextResponse.json({ error: "No user for session" }, { status: 404 });

  // Email lives in password_credentials (isolated from the encrypted-email
  // design); handle (optional public username) on users.
  const { data: cred, error: credErr } = await supabase
    .from("password_credentials")
    .select("email")
    .eq("user_id", userId)
    .maybeSingle();
  if (credErr) return NextResponse.json({ error: "Could not read the account" }, { status: 503 });
  if (!cred?.email) return NextResponse.json({ error: "Account has no email" }, { status: 400 });
  const { data: user } = await supabase.from("users").select("handle").eq("id", userId).maybeSingle();

  const jwt = await mintWalletJwt({ id: userId, email: cred.email, username: user?.handle ?? null });
  return NextResponse.json({ jwt, userId });
}
