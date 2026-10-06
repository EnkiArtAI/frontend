import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { sweepAndFlush } from "@/lib/payments/settle";
import { cronDenied } from "@/lib/cron";

// Each voided authorisation closes its nonce account on chain, one
// transaction at a time; what does not fit is next run's work.
export const maxDuration = 60;

/**
 * Every five minutes (vercel.json): void the payment authorisations nobody
 * will capture and close their nonce accounts (REC-7). The generate route
 * sweeps a handful per request, which left them open whenever nobody
 * generated: one sat in status generating from 2026-08-12 for six weeks.
 */
export async function GET(req: NextRequest) {
  const denied = cronDenied(req);
  if (denied) return denied;
  return NextResponse.json({ swept: await sweepAndFlush(getSupabaseServerClient(), 10) });
}
