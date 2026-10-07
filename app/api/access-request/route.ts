import { isDbUnreachable, dbUnavailableResponse } from "@/lib/db-error";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

// Stores landing-page "Request access" applications in the access_requests
// table. Public route (whitelisted in proxy.ts) — anonymous visitors apply
// before they have any account, so it is IP + email rate-limited instead.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  // 5 applications per 10 minutes per IP.
  const ipLimit = checkRequestRateLimit(rateLimitKey(req, "access-request"), 5, 10 * 60 * 1000);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit.retryAfterSeconds);

  let body: { email?: unknown; about?: unknown; socials?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const about = String(body.about ?? "").trim();
  const socials = String(body.socials ?? "").trim();

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
  }
  if (!about) {
    return NextResponse.json({ error: "Please tell us a bit about yourself." }, { status: 400 });
  }
  if (about.length > 2000 || socials.length > 500) {
    return NextResponse.json({ error: "Your answer is too long." }, { status: 400 });
  }

  // 3 (re-)submissions per hour per email.
  const emailLimit = checkRequestRateLimit(rateLimitKey(req, "access-request-email", email), 3, 60 * 60 * 1000);
  if (!emailLimit.allowed) return rateLimitResponse(emailLimit.retryAfterSeconds);

  try {
    const supabase = getSupabaseServerClient();
    // Insert-only: emails are unverified, so re-submitting must never
    // overwrite an existing application (anyone could vandalize any
    // applicant's text by supplying their email). A duplicate returns the
    // same success response as a first application — no oracle revealing
    // whether an email has already applied.
    const { error } = await supabase
      .from("access_requests")
      .insert({ email, about, socials: socials || null });
    if (error && error.code !== "23505") {
      if (isDbUnreachable(error)) return dbUnavailableResponse();
      console.error("[access-request] insert failed:", error);
      return NextResponse.json({ error: "Could not save your application. Please try again." }, { status: 500 });
    }
  } catch (err) {
    if (isDbUnreachable(err)) return dbUnavailableResponse();
    console.error("[access-request] storage unavailable:", err);
    return NextResponse.json({ error: "Could not save your application. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
