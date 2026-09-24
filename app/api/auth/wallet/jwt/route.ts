/**
 * POST /api/auth/wallet/jwt → { jwt, userId }
 *
 * Turns our app session into the short-lived external JWT that CDP validates
 * (against /api/auth/wallet/jwks or a pasted static key) to provision the
 * user's embedded wallets. sub is ALWAYS users.id so the vendor sees a stable
 * identity whether the session is still the fresh-login bridge
 * (wallet_address = users.id) or already carries the real wallet address.
 *
 * The email, when there is one, comes from password_credentials or from a
 * provider identity (auth_identities); emailVerified is only what that source
 * established. A social only account without an email still gets its wallet.
 *
 * The client feeds this to CDP via CdpProvider's customAuth.getJwt callback.
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

  let email: string | null = null;
  let emailVerified = false;
  const { data: cred } = await supabase
    .from("password_credentials")
    .select("email")
    .eq("user_id", userId)
    .maybeSingle();
  if (cred?.email) {
    email = cred.email;
    emailVerified = true; // the password flow's standing claim to the vendor; unchanged here
  } else {
    // A missing auth_identities table (migration not run) reads as no identity.
    const { data: ids } = await supabase
      .from("auth_identities")
      .select("email, email_verified")
      .eq("user_id", userId)
      .not("email", "is", null)
      .order("email_verified", { ascending: false })
      .limit(1);
    const id = ids?.[0];
    if (id?.email) {
      email = id.email as string;
      emailVerified = id.email_verified === true;
    }
  }
  const { data: user } = await supabase.from("users").select("handle").eq("id", userId).maybeSingle();

  const jwt = await mintWalletJwt({ id: userId, email, emailVerified, username: user?.handle ?? null });
  return NextResponse.json({ jwt, userId });
}
