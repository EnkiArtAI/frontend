import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { advanceGenerationEscrow } from "@/lib/payments/escrow/server-lifecycle";
import { EscrowPaymentError, escrowServerChain } from "@/lib/payments/escrow/server-chain";
import { escrowRoute } from "@/lib/payments/escrow/server-route";
export const runtime = "nodejs";
const schema = z.object({ intentId: z.string().uuid() }).strict();
export async function POST(req: NextRequest) {
  return escrowRoute(req, "cancel", async owner => {
    const body = schema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new EscrowPaymentError(400, "Choose a valid image request to cancel.");
    const result = await advanceGenerationEscrow(getSupabaseServerClient(), escrowServerChain(), body.data.intentId, owner, true);
    return { intentId: body.data.intentId, paymentScheme: "escrow", cancelled: true,
      state: result.batch.state, refundPending: result.batch.state !== "closed" };
  });
}
