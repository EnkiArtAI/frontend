import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { sweepAndFlush } from "@/lib/payments/settle";
import { cronDenied } from "@/lib/cron";

// A voided row whose nonce account is not closed in the same run is never
// picked up again (both sweeps skip voided rows), and a close can wait about
// a minute for its blockhash. So: one row of each kind per round, void then
// close, and no new round after two minutes of the five.
export const maxDuration = 300;
const STOP_STARTING_MS = 120_000;

/**
 * Every five minutes (vercel.json): void the payment authorisations nobody
 * will capture and close their nonce accounts (REC-7). The generate route
 * sweeps a handful per request, which left them open whenever nobody
 * generated: one sat in status generating from 2026-08-12 for six weeks.
 */
export async function GET(req: NextRequest) {
  const denied = cronDenied(req);
  if (denied) return denied;
  const supabase = getSupabaseServerClient();
  const stopAt = Date.now() + STOP_STARTING_MS;
  let swept = 0;
  while (Date.now() < stopAt) {
    const n = await sweepAndFlush(supabase, 1);
    if (!n) break;
    swept += n;
  }
  return NextResponse.json({ swept });
}
