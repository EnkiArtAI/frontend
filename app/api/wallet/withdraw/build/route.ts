/**
 * POST /api/wallet/withdraw/build — { to, amountMicro? | all? }
 * → { requestId, transaction (base64, fee payer signed), amountMicro, to,
 *    from, expiresInSec }. The client signs `transaction` in the wallet and
 * posts it to /submit. Nothing moves here.
 */
import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { getClientIp, hashIp } from "@/lib/ip-hash";
import { getUsdcBalance } from "@/lib/usdc-balance";
import { feePayerKeypair, solanaConnection, usdcMint } from "@/lib/payments/solana";
import {
  WITHDRAW_TTL_MS,
  TABLE_MISSING,
  buildWithdrawTx,
  checkWithdrawRequest,
  isTableMissing,
  parseAmountMicro,
  parsePubkey,
  recentWithdrawalCount,
  resolveWithdrawer,
  withdrawLimited,
} from "@/lib/payments/withdraw";

export const runtime = "nodejs";

const refuse = (r: { status: number; error: string; code?: string }) =>
  NextResponse.json({ error: r.error, ...(r.code && { code: r.code }) }, { status: r.status });

export async function POST(req: NextRequest) {
  let body: { to?: unknown; amountMicro?: unknown; all?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();
    // Ban TOLERANT: a ban locks the marketplace, never the user's own funds.
    const who = await resolveWithdrawer(supabase, req.headers.get("X-Session-Token"));
    if (!who) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    if (!who.from) return NextResponse.json({ error: "No Solana wallet on this account" }, { status: 400 });

    const feePayer = feePayerKeypair();
    const from = new PublicKey(who.from);
    const balanceMicro = Math.round((await getUsdcBalance(who.from)) * 1_000_000);
    const amountMicro = body.all === true ? balanceMicro : parseAmountMicro(body.amountMicro);
    const to = parsePubkey(body.to);
    const refusal = checkWithdrawRequest({ to, from, feePayer: feePayer.publicKey, amountMicro, balanceMicro });
    if (refusal) return refuse(refusal);

    const limited = withdrawLimited(await recentWithdrawalCount(supabase, who.userId));
    if (limited) return refuse(limited);

    const mint = usdcMint();
    const built = await buildWithdrawTx(solanaConnection(), {
      feePayer, from, to: to!, mint, amountMicro: amountMicro!,
    });
    const { data, error } = await supabase
      .from("withdrawals")
      .insert({
        user_id: who.userId,
        from_address: who.from,
        to_address: to!.toBase58(),
        amount_micro: amountMicro,
        mint: mint.toBase58(),
        message_hash: built.messageHash,
        ip_hash: hashIp(getClientIp(req)),
      })
      .select("id")
      .single();
    if (error) throw error;

    return NextResponse.json({
      requestId: data.id,
      transaction: built.transaction,
      amountMicro,
      to: to!.toBase58(),
      from: who.from,
      expiresInSec: WITHDRAW_TTL_MS / 1000,
    });
  } catch (e) {
    if (isTableMissing(e)) return refuse(TABLE_MISSING);
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[wallet/withdraw/build]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not prepare the withdrawal" }, { status: 500 });
  }
}
