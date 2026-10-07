import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Vercel's scheduler calls a cron route with `Authorization: Bearer
 * $CRON_SECRET` once that variable is set on the project. The routes are
 * public in the proxy (the scheduler holds no team cookie), so this check is
 * their only door: without the variable they stay shut, never open.
 * Returns null when the caller is the scheduler.
 */
export function cronDenied(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Scheduled jobs are not configured on this environment (CRON_SECRET)." }, { status: 503 });
  }
  const sent = req.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(sent), digest(`Bearer ${secret}`))
    ? null
    : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
