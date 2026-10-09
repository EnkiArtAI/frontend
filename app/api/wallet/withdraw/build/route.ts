/**
 * POST /api/wallet/withdraw/build — { from, to, amountMicro? | all? }
 * → { requestId, transaction (base64, fee payer signed), amountMicro, to,
 *    from, chain, expiresInSec }. The client signs `transaction` in the wallet and
 * posts it to /submit. Nothing moves here, so no step-up is asked here
 * either (BAN-8): the step-up is bound to this request's own id, which this
 * route is what mints, and it is checked where it matters — immediately
 * before /submit claims the row and broadcasts.
 */
import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { getClientIp, hashIp } from "@/lib/ip-hash";
import { getUsdcBalance } from "@/lib/usdc-balance";
import { feePayerKeypair, solanaChainKey, solanaConnection, usdcMint } from "@/lib/payments/solana";
import {
  WITHDRAW_TTL_MS,
  NOT_MIGRATED,
  buildWithdrawTx,
  checkWithdrawRequest,
  insertWithdrawal,
  isNotMigrated,
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
  let body: { from?: unknown; to?: unknown; amountMicro?: unknown; all?: unknown };
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
    const refusal = checkWithdrawRequest({
      to, from, fromClaimed: body.from, feePayer: feePayer.publicKey, amountMicro, balanceMicro,
    });
    if (refusal) return refuse(refusal);

    const limited = withdrawLimited(await recentWithdrawalCount(supabase, who.userId));
    if (limited) return refuse(limited);

    const mint = usdcMint();
    const built = await buildWithdrawTx(solanaConnection(), {
      feePayer, from, to: to!, mint, amountMicro: amountMicro!,
    });
    if ("status" in built) return refuse(built);

    const inserted = await insertWithdrawal(supabase, {
      userId: who.userId,
      from: who.from,
      to: to!.toBase58(),
      amountMicro: amountMicro!,
      mint: mint.toBase58(),
      messageHash: built.messageHash,
      ipHash: hashIp(getClientIp(req)),
    });
    if ("status" in inserted) return refuse(inserted);

    return NextResponse.json({
      requestId: inserted.id,
      transaction: built.transaction,
      amountMicro,
      to: to!.toBase58(),
      from: who.from,
      chain: solanaChainKey(),
      expiresInSec: WITHDRAW_TTL_MS / 1000,
    });
  } catch (e) {
    if (isNotMigrated(e)) return refuse(NOT_MIGRATED);
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[wallet/withdraw/build]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not prepare the withdrawal" }, { status: 500 });
  }
}
