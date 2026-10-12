import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { prepareGenerationEscrow } from "@/lib/payments/escrow/server-deposit";
import { EscrowPaymentError, escrowServerChain } from "@/lib/payments/escrow/server-chain";
import { escrowRoute } from "@/lib/payments/escrow/server-route";
export const runtime = "nodejs";
const schema = z.object({ intentId: z.string().uuid(), units: z.number().int().min(1).max(24) }).strict();
/** Prepare one on-chain deposit for the entire paid batch. It is not sent until the buyer signs. */
export async function POST(req: NextRequest) {
  return escrowRoute(req, "authorize", async owner => {
    const body = schema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new EscrowPaymentError(400, "Choose a valid number of images before paying.");
    return prepareGenerationEscrow(getSupabaseServerClient(), escrowServerChain(), { ...body.data, owner });
  });
}
