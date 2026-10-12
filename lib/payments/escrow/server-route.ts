import { NextRequest, NextResponse } from "next/server";
import { authRefusal, checkRateLimit, requireAuth } from "@/lib/auth";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { EscrowPaymentError } from "./server-chain";

/** Session ownership and plain error messages apply to every escrow hand-off endpoint. */
export async function escrowRoute(req: NextRequest, operation: string,
  run: (owner: string) => Promise<unknown>) {
  const ip = checkRequestRateLimit(rateLimitKey(req, `payments:${operation}:ip`), 120, 60_000);
  if (!ip.allowed) return rateLimitResponse(ip.retryAfterSeconds);
  let user;
  try { user = await requireAuth(req); } catch (error) { return authRefusal(error); }
  if (!checkRateLimit(user.userId, `payments:${operation}`, 60, 60_000)) {
    return NextResponse.json({ error: "Please wait before checking this payment again." }, { status: 429 });
  }
  try {
    const response = NextResponse.json(await run(user.walletAddress));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof EscrowPaymentError ? error.message : "The payment is temporarily unavailable. Please check its status later." },
      { status: error instanceof EscrowPaymentError ? error.status : 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
