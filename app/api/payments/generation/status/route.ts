import { NextRequest } from "next/server";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { generationEscrowStatus } from "@/lib/payments/escrow/server-deposit";
import { EscrowPaymentError, escrowServerChain } from "@/lib/payments/escrow/server-chain";
import { escrowRoute } from "@/lib/payments/escrow/server-route";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  return escrowRoute(req, "status", async owner => {
    const intentId = z.string().uuid().safeParse(req.nextUrl.searchParams.get("intentId"));
    if (!intentId.success) throw new EscrowPaymentError(400, "Choose a valid payment to check.");
    const db = getSupabaseServerClient();
    const result = await generationEscrowStatus(db, escrowServerChain(), intentId.data, owner);
    if (!result.funded) return result;
    const units = await db.from("generation_escrow_units").select("unit_index,state,generation_id").eq("intent_id", intentId.data);
    const batch = await db.from("generation_escrow_batches").select("state,delivered_units").eq("intent_id", intentId.data).maybeSingle();
    if (units.error || batch.error) throw new EscrowPaymentError(503, "The image request status is temporarily unavailable.");
    const deliveredIds = (units.data ?? []).filter(unit => unit.state === "delivered" && unit.generation_id).map(unit => unit.generation_id);
    const images = deliveredIds.length ? await db.from("generated_images").select("generation_id,storage_url")
      .in("generation_id", deliveredIds).eq("accepted", true).is("deleted_at", null) : { data: [], error: null };
    if (images.error) throw new EscrowPaymentError(503, "The saved image status is temporarily unavailable.");
    return { ...result, units: (units.data ?? []).map(unit => ({ ...unit,
      ...(unit.state === "delivered" ? { imageUrl: images.data?.find(image => image.generation_id === unit.generation_id)?.storage_url ?? null } : {}),
    })), batch: batch.data ?? null };
  });
}
