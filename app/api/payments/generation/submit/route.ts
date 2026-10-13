import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { submitGenerationEscrow } from "@/lib/payments/escrow/server-deposit";
import { EscrowPaymentError, escrowServerChain } from "@/lib/payments/escrow/server-chain";
import { escrowRoute } from "@/lib/payments/escrow/server-route";
export const runtime = "nodejs";
const schema = z.object({ intentId: z.string().uuid(), signedTransaction: z.string().min(64).max(1700) }).strict();
/** Deposit into escrow. Generation starts only after the funded accounts are verified. */
export async function POST(req: NextRequest) {
  return escrowRoute(req, "submit", async owner => {
    const body = schema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new EscrowPaymentError(400, "The signed payment is invalid.");
    return submitGenerationEscrow(getSupabaseServerClient(), escrowServerChain(), { ...body.data, owner });
  });
}
