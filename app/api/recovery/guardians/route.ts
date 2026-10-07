/**
 * Guardian management for the signed-in user.
 *
 *   GET    → { guardians: [...], threshold }
 *   POST   { guardianType: "wallet"|"email", value, label? } → adds an invited guardian
 *   PATCH  { threshold } → how many guardians must approve a recovery
 *   DELETE ?id= → removes a guardian
 *
 * inviteToken is only returned while a guardian is still invited — the owner
 * shares the /guardian?token=… link; confirmation happens in the confirm route.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { requireStepUp } from "@/lib/webauthn";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { sendMail } from "@/lib/mailer";
import { MANUAL_REMINDER_MAX, MANUAL_REMINDER_COOLDOWN_MS } from "@/lib/recovery/manual-reminder";
import { encryptString, decryptString } from "@/lib/crypto";
import { generateTotpSecret, otpauthUri, verifyTotp } from "@/lib/totp";
import { sendSms } from "@/lib/sms";
import { numericCode, sha256 } from "@/lib/password-reset";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9]\d{6,14}$/; // E.164
const SMS_RESEND_MAX = 5; // resends per cycle before a ban
const SMS_BASE_BAN_H = 24; // 1st cycle → 24h, 2nd → 48h, …

function smsBody(code: string) { return `Your Enki Art guardian code is ${code}. It expires in 10 minutes.`; }
const MAX_GUARDIANS = 10;
// Invite-reminder policy (fixed): nudge a pending email guardian every 14 days,
// at most 3 times, then mark them 'unresponsive' and stop — until re-invited.
const REMINDER_INTERVAL_DAYS = 14;
const MAX_REMINDERS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

type GuardianType = "wallet" | "email" | "authenticator" | "phone";
type GuardianRow = {
  id: string;
  guardian_type: GuardianType;
  value: string;
  label: string | null;
  status: "pending" | "confirmed" | "unresponsive";
  invite_token: string;
  reminder_count?: number;
  manual_reminder_count?: number;
  last_reminded_at?: string | null;
  created_at?: string;
};

function shape(g: GuardianRow) {
  // Invite links only apply to the two link-based types.
  const linkType = g.guardian_type === "email" || g.guardian_type === "wallet";
  return {
    id: g.id,
    guardianType: g.guardian_type,
    value: g.value,
    label: g.label,
    status: g.status,
    inviteToken: linkType && g.status !== "confirmed" ? g.invite_token : null,
    reminderCount: g.reminder_count ?? 0,
    /* For the "Send reminder" button: how many manual sends remain, and when
       the next one is allowed. Computed here so the panel renders a disabled
       state that agrees with what the remind route would answer, instead of
       letting the user click into a 429. */
    manualRemindersLeft: Math.max(0, MANUAL_REMINDER_MAX - (g.manual_reminder_count ?? 0)),
    nextManualReminderAt: (() => {
      const last = g.last_reminded_at ?? g.created_at ?? null;
      if (!last) return null;
      const t = Date.parse(last);
      return Number.isFinite(t) ? new Date(t + MANUAL_REMINDER_COOLDOWN_MS).toISOString() : null;
    })(),
  };
}

function inviteMail(origin: string, token: string, value: string, reminder: boolean) {
  const t = encodeURIComponent(token);
  const acceptLink = `${origin}/guardian?token=${t}&action=accept`;
  const declineLink = `${origin}/guardian?token=${t}&action=decline`;
  return {
    to: value,
    subject: reminder
      ? "Reminder: you were asked to be a recovery guardian on Enki Art"
      : "Someone trusts you as their recovery guardian on Enki Art",
    text:
      `Hi,\n\n` +
      (reminder
        ? `A quick reminder — someone named you as a recovery guardian for their Enki Art account and is still waiting for your answer.\n\n`
        : `Someone you know named you as a recovery guardian for their Enki Art account.\nIf they ever get locked out, your approval helps them back in.\n\n`) +
      `Accept the role:\n${acceptLink}\n\n` +
      `Or decline it:\n${declineLink}\n\n` +
      `If you don't know what this is about, you can safely ignore this email.`,
  };
}

/** Lazy reminder engine (no cron): on the owner's own guardian-list load,
    nudge pending email guardians that are due, and flip to 'unresponsive'
    after the 3rd. Stamp-first + row guard so concurrent loads can't double-send. */
async function sweepReminders(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  guardians: GuardianRow[]
) {
  const dueBefore = new Date(Date.now() - REMINDER_INTERVAL_DAYS * DAY_MS).toISOString();
  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://enki.gallery";
  for (const g of guardians) {
    if (g.status !== "pending" || g.guardian_type !== "email") continue;
    const count = g.reminder_count ?? 0;
    if (count >= MAX_REMINDERS) continue;
    const last = g.last_reminded_at ?? g.created_at ?? null;
    if (!last || last > dueBefore) continue; // not due yet
    const nextCount = count + 1;
    const nextStatus = nextCount >= MAX_REMINDERS ? "unresponsive" : "pending";
    const { data: stamped } = await supabase
      .from("recovery_guardians")
      .update({ reminder_count: nextCount, last_reminded_at: new Date().toISOString(), status: nextStatus })
      .eq("id", g.id)
      .eq("reminder_count", count) // guard: lose the race → skip
      .eq("status", "pending")
      .select("id");
    if (!stamped?.length) continue;
    g.status = nextStatus; g.reminder_count = nextCount; // reflect in the response
    await sendMail(inviteMail(origin, g.invite_token, g.value, true)).catch(() => {});
  }
}

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const [gRes, settingsRes] = await Promise.all([
    supabase
      .from("recovery_guardians")
      .select("id, guardian_type, value, label, status, invite_token, reminder_count, manual_reminder_count, last_reminded_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    supabase.from("recovery_settings").select("threshold").eq("user_id", userId).maybeSingle(),
  ]);
  // Degrade gracefully if the reminder columns aren't migrated yet.
  const guardians = (gRes.error
    ? (await supabase.from("recovery_guardians").select("id, guardian_type, value, label, status, invite_token").eq("user_id", userId).order("created_at", { ascending: true })).data
    : gRes.data) as GuardianRow[] | null;

  if (guardians?.length) await sweepReminders(supabase, guardians);

  return NextResponse.json({
    guardians: (guardians ?? []).map(shape),
    threshold: settingsRes.data?.threshold ?? 2,
  });
}

export async function POST(req: NextRequest) {
  const limit = checkRequestRateLimit(rateLimitKey(req, "guardians:add"), 10, 60_000);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { guardianType?: string; value?: string; label?: string; reinviteId?: string; verifyId?: string; code?: string; phoneResendId?: string; phoneVerifyId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Adding a guardian adds someone who can reset the password: a step-up.
  // Confirming, re-inviting and SMS codes continue one already added.
  if (!body.verifyId && !body.reinviteId && !body.phoneResendId && !body.phoneVerifyId) {
    const blocked = await requireStepUp(req, userId, "guardians");
    if (blocked) return blocked;
  }

  // Verify an authenticator guardian: the user enters a TOTP code from their
  // app; a match confirms it (decrypt the stored secret, check ±1 window).
  if (body.verifyId && body.code) {
    const { data: g } = await supabase
      .from("recovery_guardians")
      .select("id, status, guardian_value_ct, guardian_value_iv, guardian_value_tag, guardian_value_kid")
      .eq("id", body.verifyId)
      .eq("user_id", userId)
      .eq("guardian_type", "authenticator")
      .maybeSingle();
    if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (g.status === "confirmed") return NextResponse.json({ ok: true, already: true });
    let secret: string;
    try {
      secret = decryptString({ encrypted: g.guardian_value_ct, iv: g.guardian_value_iv, authTag: g.guardian_value_tag }, userId);
    } catch {
      return NextResponse.json({ error: "Couldn't read the authenticator — remove it and set it up again." }, { status: 500 });
    }
    if (!verifyTotp(secret, body.code)) {
      return NextResponse.json({ error: "That code isn't right — enter the current one from your app." }, { status: 400 });
    }
    await supabase.from("recovery_guardians").update({ status: "confirmed", confirmed_at: new Date().toISOString() }).eq("id", g.id);
    return NextResponse.json({ ok: true, confirmed: true });
  }

  // Resend an SMS code — escalating cooldown (1,2,3,4,5 min), then a ban that
  // grows 24h → 48h → 72h per completed 5-resend cycle.
  if (body.phoneResendId) {
    const { data: g } = await supabase
      .from("recovery_guardians")
      .select("id, value, status, sms_last_sent_at, sms_resend_count, sms_ban_count, sms_banned_until")
      .eq("id", body.phoneResendId).eq("user_id", userId).eq("guardian_type", "phone").maybeSingle();
    if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (g.status === "confirmed") return NextResponse.json({ ok: true, already: true });
    const now = Date.now();
    if (g.sms_banned_until && new Date(g.sms_banned_until).getTime() > now) {
      return NextResponse.json({ error: "Too many attempts", bannedUntil: g.sms_banned_until }, { status: 429 });
    }
    const cooldownMs = ((g.sms_resend_count ?? 0) + 1) * 60_000;
    const nextAt = (g.sms_last_sent_at ? new Date(g.sms_last_sent_at).getTime() : 0) + cooldownMs;
    if (now < nextAt) {
      return NextResponse.json({ error: "Please wait", resendAvailableAt: new Date(nextAt).toISOString() }, { status: 429 });
    }
    const code = numericCode(6);
    const nextCount = (g.sms_resend_count ?? 0) + 1;
    const patch: Record<string, unknown> = { sms_code_hash: sha256(code), sms_last_sent_at: new Date().toISOString(), sms_resend_count: nextCount };
    if (nextCount >= SMS_RESEND_MAX) {
      const banCount = (g.sms_ban_count ?? 0) + 1;
      patch.sms_ban_count = banCount;
      patch.sms_resend_count = 0;
      patch.sms_banned_until = new Date(now + banCount * SMS_BASE_BAN_H * 3600_000).toISOString();
    }
    await supabase.from("recovery_guardians").update(patch).eq("id", g.id);
    await sendSms({ to: g.value, body: smsBody(code) }).catch(() => {});
    return NextResponse.json({
      ok: true,
      resendAvailableAt: new Date(Date.now() + ((patch.sms_resend_count as number) + 1) * 60_000).toISOString(),
      bannedUntil: (patch.sms_banned_until as string) ?? null,
    });
  }

  // Verify an SMS code → confirm the phone guardian.
  if (body.phoneVerifyId && body.code) {
    const { data: g } = await supabase
      .from("recovery_guardians")
      .select("id, status, sms_code_hash, sms_last_sent_at")
      .eq("id", body.phoneVerifyId).eq("user_id", userId).eq("guardian_type", "phone").maybeSingle();
    if (!g) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (g.status === "confirmed") return NextResponse.json({ ok: true, already: true });
    if (!g.sms_code_hash || !g.sms_last_sent_at || Date.now() - new Date(g.sms_last_sent_at).getTime() > 10 * 60_000) {
      return NextResponse.json({ error: "That code expired — send a new one." }, { status: 400 });
    }
    if (sha256(String(body.code).replace(/\D/g, "")) !== g.sms_code_hash) {
      return NextResponse.json({ error: "That code isn't right." }, { status: 400 });
    }
    await supabase.from("recovery_guardians").update({ status: "confirmed", confirmed_at: new Date().toISOString(), sms_code_hash: null }).eq("id", g.id);
    return NextResponse.json({ ok: true, confirmed: true });
  }

  // Re-invite: reset a pending/unresponsive email guardian to a fresh invite
  // (reminder count back to 0) and mail them again. This is what "add them
  // again as a guardian" means after they went unresponsive.
  if (body.reinviteId) {
    const { data: g, error } = await supabase
      .from("recovery_guardians")
      .update({ status: "pending", reminder_count: 0, last_reminded_at: null, invite_token: randomBytes(24).toString("hex") })
      .eq("id", body.reinviteId)
      .eq("user_id", userId)
      .neq("status", "confirmed") // don't disturb an already-accepted guardian
      .select("id, guardian_type, value, label, status, invite_token")
      .maybeSingle();
    if (error || !g) return NextResponse.json({ error: "Could not re-invite" }, { status: 400 });
    let emailed = false;
    if (g.guardian_type === "email" && g.value) {
      const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://enki.gallery";
      emailed = (await sendMail(inviteMail(origin, (g as GuardianRow).invite_token, g.value, false))).ok;
    }
    return NextResponse.json({ guardian: shape(g as GuardianRow), emailed });
  }

  const guardianType = body.guardianType;
  let value = (body.value ?? "").trim();
  if (!["wallet", "email", "authenticator", "phone"].includes(guardianType ?? "")) {
    return NextResponse.json({ error: "Unknown guardian type" }, { status: 400 });
  }

  const { count } = await supabase
    .from("recovery_guardians")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if ((count ?? 0) >= MAX_GUARDIANS) {
    return NextResponse.json({ error: `You can have up to ${MAX_GUARDIANS} guardians` }, { status: 400 });
  }

  // ── Authenticator (TOTP): generate a secret, store it ENCRYPTED, hand the
  // QR/secret back once for setup. Confirmed later via the verify branch. ──
  if (guardianType === "authenticator") {
    const secret = generateTotpSecret();
    const enc = encryptString(secret, userId); // AAD binds it to this user
    const { data: me } = await supabase.from("users").select("handle").eq("id", userId).maybeSingle();
    const { data: g, error } = await supabase
      .from("recovery_guardians")
      .insert({
        user_id: userId, guardian_type: "authenticator", value: "Authenticator app",
        label: body.label?.trim() || null, status: "pending", invite_token: randomBytes(24).toString("hex"),
        guardian_value_ct: enc.encrypted, guardian_value_iv: enc.iv,
        guardian_value_tag: enc.authTag, guardian_value_kid: enc.kid ?? "field-v1",
      })
      .select("id, guardian_type, value, label, status, invite_token")
      .single();
    if (error) return NextResponse.json({ error: "Could not add authenticator" }, { status: 500 });
    return NextResponse.json({
      guardian: shape(g as GuardianRow),
      setup: { secret, otpauthUri: otpauthUri(secret, me?.handle || "account"), guardianId: g.id },
    });
  }

  // ── Phone: store the number, text a 6-digit code, confirm via verify. ──
  if (guardianType === "phone") {
    value = value.replace(/[\s()-]/g, "");
    if (!PHONE.test(value)) return NextResponse.json({ error: "Use an international number like +49170…" }, { status: 400 });
    const code = numericCode(6);
    const { data: g, error } = await supabase
      .from("recovery_guardians")
      .insert({
        user_id: userId, guardian_type: "phone", value, label: body.label?.trim() || null,
        status: "pending", invite_token: randomBytes(24).toString("hex"),
        sms_code_hash: sha256(code), sms_last_sent_at: new Date().toISOString(), sms_resend_count: 0,
      })
      .select("id, guardian_type, value, label, status, invite_token")
      .single();
    if (error) {
      const dup = error.code === "23505";
      return NextResponse.json({ error: dup ? "That number is already on your list" : "Could not add number" }, { status: dup ? 409 : 500 });
    }
    await sendSms({ to: value, body: smsBody(code) }).catch(() => {});
    return NextResponse.json({
      guardian: shape(g as GuardianRow),
      phoneSetup: { guardianId: g.id, phone: value, resendAvailableAt: new Date(Date.now() + 60_000).toISOString() },
    });
  }

  // ── Wallet / email ──
  if (guardianType === "wallet") {
    try {
      new PublicKey(value);
    } catch {
      return NextResponse.json({ error: "That's not a valid Solana address" }, { status: 400 });
    }
  } else {
    value = value.toLowerCase();
    if (!EMAIL.test(value)) return NextResponse.json({ error: "That's not a valid email" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("recovery_guardians")
    .insert({
      user_id: userId,
      guardian_type: guardianType,
      value,
      label: body.label?.trim() || null,
      status: "pending",
      invite_token: randomBytes(24).toString("hex"),
    })
    .select("id, guardian_type, value, label, status, invite_token")
    .single();
  if (error) {
    const dup = error.code === "23505";
    return NextResponse.json(
      { error: dup ? "That guardian is already on your list" : "Could not add guardian" },
      { status: dup ? 409 : 500 }
    );
  }

  // Email guardians get their invite mailed right away — the owner doesn't
  // have to copy anything. Wallet guardians still get the copy-link flow.
  // Guardians are OUTSIDERS: mail links always use the public site origin
  // (NEXT_PUBLIC_APP_URL points at localhost in dev and feeds the CDP JWT
  // issuer, so it must not be reused here).
  // Email guardians get their invite mailed right away (accept + decline links);
  // wallet guardians still use the copy-link flow. Guardians are OUTSIDERS, so
  // links always use the public site origin (NEXT_PUBLIC_SITE_ORIGIN).
  let emailed = false;
  if (guardianType === "email") {
    const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://enki.gallery";
    emailed = (await sendMail(inviteMail(origin, (data as GuardianRow).invite_token, value, false))).ok;
  }

  return NextResponse.json({ guardian: shape(data as GuardianRow), emailed }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // Guardians can reset the password: who they are is a step-up decision.
  const blocked = await requireStepUp(req, userId, "guardians");
  if (blocked) return blocked;

  let threshold: unknown;
  try {
    ({ threshold } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1 || threshold > 10) {
    return NextResponse.json({ error: "threshold must be 1–10" }, { status: 400 });
  }

  const { error } = await supabase
    .from("recovery_settings")
    .upsert({ user_id: userId, threshold, updated_at: new Date().toISOString() });
  if (error) return NextResponse.json({ error: "Could not save" }, { status: 500 });
  return NextResponse.json({ threshold });
}

export async function DELETE(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const blocked = await requireStepUp(req, userId, "guardians");
  if (blocked) return blocked;

  // Fetch first: after a successful delete the removed EMAIL guardian gets a
  // short goodbye mail, so they know the responsibility ended.
  const { data: g } = await supabase
    .from("recovery_guardians")
    .select("guardian_type, value")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  const { error } = await supabase.from("recovery_guardians").delete().eq("id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: "Could not remove" }, { status: 500 });

  if (g?.guardian_type === "email" && g.value) {
    await sendMail({
      to: g.value,
      subject: "You're no longer a recovery guardian on Enki Art",
      text:
        `Hi,\n\n` +
        `You were removed as a recovery guardian for an Enki Art account.\n` +
        `Nothing is required from you, and any old invite links stopped working.\n\n` +
        `Thanks for having been there.`,
    }).catch(() => { /* the removal itself succeeded — mail is best-effort */ });
  }

  return NextResponse.json({ ok: true });
}
