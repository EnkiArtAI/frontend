/**
 * Guardian recovery — request + status.
 *
 *   POST { email } → { requestId, ownerKey, guardians } — starts a recovery:
 *     every CONFIRMED email guardian gets a 7-digit code by mail. ownerKey
 *     stays in the owner's browser and is required to complete the reset.
 *   GET ?id=…&key=… → { status, approved, threshold } — owner polling.
 *     The poll doubles as the REMINDER engine (no cron needed): guardians who
 *     haven't answered for reminder_days (owner setting) get a fresh code
 *     mailed again, at most once per interval.
 *
 * Rate-limited hard; requests expire after 7 days.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { numericCode, sha256 } from "@/lib/password-reset";
import { sendMail } from "@/lib/mailer";
import { recoveryThreshold } from "@/lib/recovery/threshold";

const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const bodySchema = z.object({ email: z.string().email().max(320) });

export async function POST(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "recovery:request:ip"), 5, 60 * 60 * 1000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const email = parsed.data.email.trim().toLowerCase();

  const supabase = getSupabaseServerClient();
  const { data: cred } = await supabase
    .from("password_credentials")
    .select("user_id")
    .eq("email", email)
    .maybeSingle();
  if (!cred) {
    return NextResponse.json({ error: "No account or no guardians for this email" }, { status: 404 });
  }

  const { data: guardians } = await supabase
    .from("recovery_guardians")
    .select("id, value")
    .eq("user_id", cred.user_id)
    .eq("guardian_type", "email")
    .eq("status", "confirmed");
  if (!guardians || guardians.length === 0) {
    return NextResponse.json(
      { error: "No account or no guardians for this email" },
      { status: 404 },
    );
  }

  const ownerKey = randomBytes(24).toString("hex");
  const { data: request, error: reqError } = await supabase
    .from("recovery_requests")
    .insert({
      user_id: cred.user_id,
      status: "pending",
      owner_key_hash: sha256(ownerKey),
      expires_at: new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (reqError || !request) {
    console.error("[recovery/request] insert failed:", reqError?.message);
    return NextResponse.json({ error: "Could not start recovery" }, { status: 500 });
  }

  // Public origin for mailed links — recipients are outside localhost.
  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://enki.gallery";
  let notified = 0;
  for (const g of guardians) {
    const code = numericCode(7);
    const { error } = await supabase
      .from("recovery_approvals")
      .insert({ request_id: request.id, guardian_id: g.id, code_hash: sha256(code) });
    if (error) continue;
    const link = `${origin}/guardian?recovery=${request.id}&g=${g.id}`;
    const mail = await sendMail({
      to: g.value,
      subject: "A friend needs your help getting back into Enki Art",
      text:
        `Someone you agreed to be a recovery guardian for is locked out of their Enki Art account.\n\n` +
        `If they contacted you and this is really them, open the link and enter this code:\n\n` +
        `    ${code}\n\n${link}\n\n` +
        `If nobody asked you, do nothing — the request expires in 7 days.`,
    });
    if (!mail.ok && process.env.NODE_ENV !== "production") {
      console.log(`[recovery/request] email not configured — guardian code for ${g.value}: ${code} → ${link}`);
    }
    notified += 1;
  }

  return NextResponse.json({ requestId: request.id, ownerKey, guardians: notified });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const key = req.nextUrl.searchParams.get("key");
  if (!id || !key) return NextResponse.json({ error: "id and key required" }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const { data: request } = await supabase
    .from("recovery_requests")
    .select("id, user_id, status, expires_at, owner_key_hash")
    .eq("id", id)
    .maybeSingle();
  if (!request || request.owner_key_hash !== sha256(key)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const expired = request.expires_at && new Date(request.expires_at).getTime() <= Date.now();

  const [{ count: approved }, threshold] = await Promise.all([
    supabase
      .from("recovery_approvals")
      .select("guardian_id", { count: "exact", head: true })
      .eq("request_id", id)
      .not("approved_at", "is", null),
    recoveryThreshold(supabase, request.user_id),
  ]);

  return NextResponse.json({
    status: expired ? "expired" : request.status,
    approved: approved ?? 0,
    threshold,
  });
}
