import { NextResponse } from "next/server";
import { whitelistStageActive } from "@/lib/allowlist";

// Validates the team access code and, on success, sets the httpOnly cookie the
// middleware checks. The code itself lives only in TEAM_ACCESS_CODE (server env).
export async function POST(req: Request) {
  const code = process.env.TEAM_ACCESS_CODE;
  if (!code) {
    return NextResponse.json({ ok: false, error: "Gate not configured" }, { status: 500 });
  }

  let given = "";
  try {
    const body = await req.json();
    given = (body?.code ?? "").toString();
  } catch {
    /* empty / invalid body → treated as wrong code */
  }

  if (given !== code) {
    return NextResponse.json({ ok: false, error: "Wrong access code" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, code, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}

const COOKIE = "enki_team";

/**
 * GET → { team: boolean, whitelistActive: boolean } — whether this browser
 * carries a valid team cookie, and whether the private-beta whitelist stage
 * is still active. The client beta wall (BetaGate) asks this for two
 * things: team ⇒ let TEAM-CODE holders browse the UI without a user account
 * (Kev, 2026-08-23: "eig sollte der code ja mich in die ui bringen da ich
 * team member bin"); whitelistActive ⇒ once it's false (TEAM_ACCESS_CODE
 * unset), every signed-in, non-banned account is admitted regardless of
 * role (Kev, 2026-09-24, SOC-8) — during the stage the role/allowlist rules
 * stay. Grants NOTHING by itself: every user-bound API still requires a
 * real session.
 */
export async function GET(req: Request) {
  const active = whitelistStageActive();
  if (!active) return NextResponse.json({ team: false, whitelistActive: false });
  const code = process.env.TEAM_ACCESS_CODE as string;
  const cookies = (req.headers.get("cookie") ?? "").split(/;\s*/);
  const team = cookies.some((c) => c === `${COOKIE}=${encodeURIComponent(code)}` || c === `${COOKIE}=${code}`);
  return NextResponse.json({ team, whitelistActive: true });
}
