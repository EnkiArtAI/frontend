/**
 * POST /api/auth/oauth/complete  (hand over cookie) → { token, email, banned }
 *
 * Collects the session the callback left in the hand over cookie and clears
 * it, so the hand over is bound to the browser that finished the provider
 * round trip and works once. A crafted /auth/complete link opened by someone
 * else carries no cookie and gets 401 with no token.
 */
import { NextRequest, NextResponse } from "next/server";
import { ERROR_SENTENCES, HANDOVER_COOKIE, readHandover, STATE_COOKIE_PATH } from "@/lib/auth/oauth";

export async function POST(req: NextRequest) {
  const handover = await readHandover(req.cookies.get(HANDOVER_COOKIE)?.value);
  const res = handover
    ? NextResponse.json(handover)
    : NextResponse.json({ error: ERROR_SENTENCES.state_mismatch }, { status: 401 });
  res.cookies.set(HANDOVER_COOKIE, "", { path: STATE_COOKIE_PATH, maxAge: 0 });
  return res;
}
