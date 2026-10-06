/**
 * POST /api/wallet/withdraw/submit — { requestId, signedTransaction }
 * → { signature } once the transfer is confirmed on chain.
 *
 * The fee payer signature from /build stays as it is: nothing is re-signed
 * here, so a transaction the client altered arrives already invalid.
 */
import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { feePayerKeypair, solanaConnection } from "@/lib/payments/solana";
import { submitAndConfirm } from "@/lib/payments/x402-settle";
import {
  NOT_MIGRATED,
  isExpired,
  isNotMigrated,
  resolveWithdrawer,
  transactionDead,
  verifySignedWithdrawal,
} from "@/lib/payments/withdraw";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  let body: { requestId?: unknown; signedTransaction?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const { requestId, signedTransaction } = body;
  if (typeof requestId !== "string" || !UUID.test(requestId) || typeof signedTransaction !== "string") {
    return NextResponse.json({ error: "requestId and signedTransaction are required" }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();
    const who = await resolveWithdrawer(supabase, req.headers.get("X-Session-Token"));
    if (!who) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const { data: row, error } = await supabase
      .from("withdrawals")
      .select("id, status, created_at, from_address, message_hash")
      .eq("id", requestId)
      .eq("user_id", who.userId)
      .maybeSingle();
    if (error) throw error;
    if (!row) return NextResponse.json({ error: "Unknown withdrawal" }, { status: 404 });
    if (row.status !== "pending") {
      return NextResponse.json({ error: `Withdrawal is already ${row.status}` }, { status: 409 });
    }
    if (isExpired(row.created_at)) {
      await supabase.from("withdrawals").update({ status: "expired" }).eq("id", row.id).eq("status", "pending");
      return NextResponse.json({ error: "Signing window expired, build a new withdrawal", code: "EXPIRED" }, { status: 409 });
    }

    const verified = verifySignedWithdrawal(signedTransaction, {
      messageHash: row.message_hash,
      from: new PublicKey(row.from_address),
      feePayer: feePayerKeypair().publicKey,
    });
    if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: 400 });

    // One broadcast per request: the conditional update is the claim.
    const { data: claimed } = await supabase
      .from("withdrawals")
      .update({ status: "submitted", submitted_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed?.length) return NextResponse.json({ error: "Withdrawal is already submitted" }, { status: 409 });

    const connection = solanaConnection();
    const outcome = await submitAndConfirm(connection, verified.tx);
    if (!outcome.ok) {
      // Safe to redo when nothing moved: a rejection (refused, failed on chain
      // and rolled back, or expired), or a pending one whose blockhash has
      // since expired. A pending one on a live blockhash may still land.
      const dead = outcome.pending && (await transactionDead(connection, verified.tx));
      const retryable = !outcome.pending || dead;
      await supabase
        .from("withdrawals")
        .update({ status: "failed", error: dead ? "Dropped" : outcome.pending ? "Pending" : "Rejected", tx_signature: outcome.signature })
        .eq("id", row.id);
      return NextResponse.json(
        {
          error: retryable
            ? `The network ${dead ? "dropped" : "refused"} the transfer, nothing moved`
            : "The transfer could not be confirmed",
          retryable,
          signature: outcome.signature,
        },
        { status: 502 },
      );
    }

    await supabase
      .from("withdrawals")
      .update({ status: "confirmed", tx_signature: outcome.signature, confirmed_at: new Date().toISOString() })
      .eq("id", row.id);
    return NextResponse.json({ signature: outcome.signature });
  } catch (e) {
    if (isNotMigrated(e)) return NextResponse.json({ error: NOT_MIGRATED.error, code: NOT_MIGRATED.code }, { status: NOT_MIGRATED.status });
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    console.error("[wallet/withdraw/submit]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not submit the withdrawal" }, { status: 500 });
  }
}
