import { NextRequest, NextResponse } from "next/server";
import { getUsdcBalance } from "@/lib/usdc-balance";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * GET /api/billing/balance?address=<solana wallet> → { balance } in USD.
 *
 * Non-custodial: reads the wallet's own on-chain USDC balance (USDC ≈ $1)
 * instead of a ledger row we control. Enki cannot inflate, freeze or lose it.
 */
export async function GET(req: NextRequest) {
  // Public (a banned account reads its balance without the team cookie), and
  // every call is an RPC request on our provider: bounded per IP.
  const limit = checkRequestRateLimit(rateLimitKey(req, "billing:balance"), 30, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
  const address = req.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json({ balance: 0 });

  try {
    const balance = await getUsdcBalance(address);
    return NextResponse.json({ balance });
  } catch (e) {
    console.error("[/api/billing/balance] error:", e);
    return NextResponse.json({ balance: 0 });
  }
}
