/**
 * POST /api/payments/generation/submit
 *
 * Takes the buyer's signed transaction and stores it, unbroadcast. From this
 * moment the generation may run: we hold a payment we can complete, and the
 * buyer holds our promise that we only will if the image arrives.
 *
 *   Body:   { intentId, signedTransaction }
 *   Returns { authorized: true }
 *
 * The obvious attack is returning a DIFFERENT signed transaction — same nonce,
 * transfers shrunk or redirected. So the transaction is rebuilt from the
 * stored intent and compared message-for-message; only the signatures are
 * allowed to differ, because they are the only part that legitimately does.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { authRefusal, requireAuth, checkRateLimit } from "@/lib/auth";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { matchesBuiltTransaction, hasRequiredSignatures } from "@/lib/payments/authorize-tx";
import { readNonce } from "@/lib/payments/nonce";
import { solanaConnection, feePayerKeypair } from "@/lib/payments/solana";
import { storeAuthorization } from "@/lib/payments/authorization";
import {
  authorizationFor,
  exactWallet,
  enkiWallet,
  type IntentRow,
} from "@/lib/payments/authorize-flow";

export const runtime = "nodejs";

const schema = z.object({
  intentId: z.string().uuid(),
  // A Solana transaction is capped at 1232 bytes on the wire; base64 of that
  // is under 1700. The bound refuses a body that cannot be one.
  signedTransaction: z.string().min(64).max(4000),
});

export async function POST(req: NextRequest) {
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "payments:submit:ip"), 120, 60_000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  let authUser;
  try {
    authUser = await requireAuth(req);
  } catch (e) {
    return authRefusal(e);
  }
  if (!checkRateLimit(authUser.userId, "payments:submit", 60, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data: intent } = await supabase
    .from("generation_payment_intents")
    .select(
      "id, buyer_wallet, artist_wallet, artist_amount_micro, model_cost_micro, enki_fee_micro, total_micro, nonce_account, fronted_atas, authorized_at, captured_at, voided_at",
    )
    .eq("id", parsed.data.intentId)
    .ilike("buyer_wallet", authUser.walletAddress)
    .maybeSingle();

  if (!intent) return NextResponse.json({ error: "Payment intent not found" }, { status: 404 });
  if (!intent.nonce_account) {
    return NextResponse.json({ error: "Payment was never prepared" }, { status: 409 });
  }
  if (intent.authorized_at || intent.captured_at || intent.voided_at) {
    return NextResponse.json({ error: "Payment intent is no longer open" }, { status: 409 });
  }

  const buyerWallet = await exactWallet(supabase, intent.buyer_wallet);
  if (!buyerWallet) {
    return NextResponse.json({ error: "No wallet on file for this buyer" }, { status: 409 });
  }

  try {
    const nonce = await readNonce(solanaConnection(), intent.nonce_account);
    if (!nonce) {
      // The account is gone or was never initialised, so the signature cannot
      // be valid anyway. Better a clear refusal now than a failed broadcast
      // after the image has been generated.
      return NextResponse.json({ error: "The prepared payment has expired" }, { status: 409 });
    }

    const { transaction } = authorizationFor(intent as unknown as IntentRow, buyerWallet, nonce, enkiWallet());
    if (!matchesBuiltTransaction(parsed.data.signedTransaction, transaction)) {
      console.warn("[payments/submit] returned transaction does not match ours:", intent.id);
      return NextResponse.json({ error: "Signed transaction does not match the quote" }, { status: 400 });
    }
    /* Checked separately from the message, and logged separately, because the
       two failures mean opposite things: a mismatch is someone trying to
       redirect the money, a missing signature is someone trying to skip paying
       for it. Echoing our own partial-signed transaction back satisfies the
       comparison above perfectly — it is our message — so without this the
       generation ran and the image shipped for free. */
    if (!hasRequiredSignatures(parsed.data.signedTransaction)) {
      console.warn("[payments/submit] transaction is not fully signed:", intent.id);
      return NextResponse.json({ error: "Signed transaction is missing a required signature" }, { status: 400 });
    }

    const stored = await storeAuthorization(supabase, {
      intentId: intent.id,
      buyerWallet: intent.buyer_wallet,
      signedTx: parsed.data.signedTransaction,
      nonceAccount: intent.nonce_account,
      nonceAuthority: feePayerKeypair().publicKey.toBase58(),
    });
    if (!stored) {
      return NextResponse.json({ error: "Payment intent is no longer open" }, { status: 409 });
    }

    return NextResponse.json({ authorized: true });
  } catch (e) {
    console.error("[payments/submit] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not store the authorisation" }, { status: 500 });
  }
}
