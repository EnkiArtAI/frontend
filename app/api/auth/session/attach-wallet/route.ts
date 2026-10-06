/**
 * POST /api/auth/session/attach-wallet  { solanaAddress, evmAddress? } → { attached, evm }
 *
 * The CDP embedded wallet is provisioned from OUR JWT (sub = users.id) and is
 * DETERMINISTIC per sub, so the client can only ever surface its own wallet.
 * We write the Solana address into auth_sessions.wallet_address (replacing the
 * users.id bridge value from email login) and map both chain addresses in
 * user_wallets, scoped to the session's users.id.
 *
 * The addresses are validated (base58 / 0x-hex) and bound to the caller's own
 * session, so a bad value can only mis-route the caller's own identity (no
 * theft — you can't sign for a wallet you don't control).
 * HARDENING TODO: verify the address against CDP server-side (@coinbase/cdp-sdk
 * end-user lookup by sub) to reject a forged address outright.
 */
import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { activeBanFor } from "@/lib/session-user";

const bodySchema = z.object({
  solanaAddress: z.string().min(32).max(64),
  evmAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullish(),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSolana(addr: string): boolean {
  try { new PublicKey(addr); return true; } catch { return false; }
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("X-Session-Token");
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !isValidSolana(parsed.data.solanaAddress)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }
  const sol = parsed.data.solanaAddress;
  const evm = parsed.data.evmAddress ?? null;

  const supabase = getSupabaseServerClient();
  const { data: session } = await supabase
    .from("auth_sessions")
    .select("wallet_address, wallet_type")
    .eq("token", token)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (session.wallet_type !== "password") {
    return NextResponse.json({ error: "Only password sessions attach wallets" }, { status: 400 });
  }

  // Resolve users.id: fresh sessions carry it directly, re-attached ones map back.
  let userId: string | null = UUID.test(session.wallet_address) ? session.wallet_address : null;
  if (!userId) {
    const { data } = await supabase
      .from("user_wallets")
      .select("user_id")
      .eq("address", session.wallet_address)
      .is("removed_at", null)
      .maybeSingle();
    userId = data?.user_id ?? null;
  }
  if (!userId) return NextResponse.json({ error: "No user for session" }, { status: 404 });
  // A suspended account maps no new wallets. The ones it already holds stay
  // reachable on /banned, through wallet/jwt, which stays ban tolerant.
  if (await activeBanFor(supabase, userId)) {
    return NextResponse.json({ error: "This account is suspended.", banned: true }, { status: 403 });
  }

  if (session.wallet_address === sol) {
    return NextResponse.json({ attached: sol, evm });
  }

  // Map both addresses (insert-if-absent; user_wallets is the ownership truth).
  // CDP embedded wallets are MPC/TEE EOAs → wallet_type 'external_eoa' (the value
  // the user_wallets CHECK allows for a plain owned account).
  const rows = [{ addr: sol, family: "solana", primary: true }];
  if (evm) rows.push({ addr: evm, family: "evm", primary: false });
  for (const w of rows) {
    const { data: existing } = await supabase
      .from("user_wallets")
      .select("user_id")
      .eq("address", w.addr)
      .maybeSingle();
    if (!existing) {
      const { error } = await supabase.from("user_wallets").insert({
        user_id: userId,
        address: w.addr,
        chain_family: w.family,
        wallet_type: "external_eoa",
        is_primary: w.primary,
      });
      if (error) console.error("[attach-wallet] user_wallets insert failed:", error.message);
    }
  }

  // From here the session speaks the wallet address like every other login type.
  const { error: sessErr } = await supabase
    .from("auth_sessions")
    .update({ wallet_address: sol })
    .eq("token", token);
  if (sessErr) return NextResponse.json({ error: "Could not update session" }, { status: 500 });

  return NextResponse.json({ attached: sol, evm });
}
