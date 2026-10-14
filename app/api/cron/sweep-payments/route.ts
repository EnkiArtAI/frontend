import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { escrowServerChain } from "@/lib/payments/escrow/server-chain";
import { sweepGenerationEscrows } from "@/lib/payments/escrow/server-sweep";
import { cronDenied } from "@/lib/cron";
export const runtime = "nodejs";
export const maxDuration = 300;
/** Retry immutable escrow payments and reconcile delivered images. Each settlement and reclaim is separate. */
export async function GET(req: NextRequest) {
  const denied = cronDenied(req);
  if (denied) return denied;
  try { return NextResponse.json(await sweepGenerationEscrows(getSupabaseServerClient(), escrowServerChain())); }
  catch {
    console.error("[escrow/sweep] temporarily_unavailable");
    return NextResponse.json({ error: "The payment reconciliation service is temporarily unavailable." }, { status: 503 });
  }
}
