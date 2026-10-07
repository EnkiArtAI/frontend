import crypto, { hkdfSync } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptString, decryptString } from "@/lib/crypto";
import { generateTotpSecret, otpauthUri, totpStep } from "@/lib/totp";
import { sendMail } from "@/lib/mailer";

/**
 * Step-up factors beside the passkey (Kev, 2026-10-07: "not only passkey but
 * also more authentications if the user wants it, like authenticator or
 * email 6 digit verification code"). The user picks; any one confirmed factor
 * makes step-up apply to them. Rows live in mfa_factors
 * (migrations/2026-10-07-mfa-factors.sql), readable by the service role only.
 *
 * Brute force is stopped in the database, not in memory (lib/rate-limit is
 * per instance): an attempt is claimed with a conditional update BEFORE the
 * code is compared, so parallel guesses cannot buy extra tries. Five wrong
 * codes lock the factor for 15 minutes, doubling per lockout up to a day;
 * an email code lives 10, so none outlives a lock.
 */

export type FactorKind = "totp" | "email";
export type Factor = "passkey" | FactorKind;
export type CodeCheck = "ok" | "wrong" | "locked" | "none" | "busy";
export type SendResult = "sent" | "cooldown" | "daily_cap" | "none" | "send_failed";

export const MAX_ATTEMPTS = 5;
const LOCK_BASE_MS = 15 * 60_000;
const LOCK_MAX_MS = 24 * 3600_000;
const CODE_TTL_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const SENDS_PER_DAY = 5;
// How long a started setup can be confirmed. Longer, a session that was fresh
// once could start an authenticator, keep its secret and confirm it weeks
// later, past every gate added meanwhile.
const SETUP_TTL_MS = 10 * 60_000;

type Row = {
  id: string;
  kind: FactorKind;
  secret_ct: string;
  secret_iv: string;
  secret_tag: string;
  secret_kid: string;
  confirmed_at: string | null;
  last_step: number | null;
  code_hash: string | null;
  code_expires_at: string | null;
  code_sent_at: string | null;
  sends_day: string | null;
  sends_count: number;
  failed_attempts: number;
  lockouts: number;
  locked_until: string | null;
  created_at: string;
};

// Until Kev runs the migration the table does not exist: nobody has a factor
// there yet, which is the truth, not an outage.
const missingTable = (e: { code?: string } | null) => e?.code === "PGRST205" || e?.code === "42P01";

/**
 * A password account's inbox resets its password, so an email code is no
 * second factor for it (Kev, 2026-10-07): the inbox alone would pass. It
 * uses a passkey or an authenticator app; a wallet account may use all three.
 */
export async function isPasswordAccount(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { count, error } = await supabase.from("password_credentials").select("user_id", { count: "exact", head: true }).eq("user_id", userId);
  if (error) throw error;
  return Boolean(count);
}

/** Every factor that makes step-up apply. Throws on a database error: a
    failed lookup must never read as "no factor" (fail closed). */
export async function enrolledFactors(supabase: SupabaseClient, userId: string): Promise<Factor[]> {
  const [passkeys, factors, password] = await Promise.all([
    supabase.from("webauthn_credentials").select("id", { count: "exact", head: true }).eq("user_id", userId),
    supabase.from("mfa_factors").select("kind").eq("user_id", userId).not("confirmed_at", "is", null),
    isPasswordAccount(supabase, userId),
  ]);
  if (passkeys.error) throw passkeys.error;
  if (factors.error && !missingTable(factors.error)) throw factors.error;
  return [
    ...((passkeys.count ?? 0) > 0 ? (["passkey"] as const) : []),
    ...((factors.data ?? []) as { kind: FactorKind }[]).map((r) => r.kind).filter((k) => !(password && k === "email")),
  ];
}

function codeKey(): Uint8Array {
  const pepper = process.env.AUTH_PEPPER;
  if (!pepper) throw new Error("AUTH_PEPPER not configured");
  return new Uint8Array(hkdfSync("sha256", Buffer.from(pepper, "base64"), new Uint8Array(0), Buffer.from("enki-mfa-code-v1"), 32));
}
// Keyed, so six digits cannot be reversed from a dump by trying all 10^6.
const codeHash = (factorId: string, code: string) =>
  crypto.createHmac("sha256", codeKey()).update(`${factorId}:${code}`).digest("hex");

const sealed = (userId: string, secret: string) => {
  const e = encryptString(secret, userId);
  return { secret_ct: e.encrypted, secret_iv: e.iv, secret_tag: e.authTag, secret_kid: e.kid ?? "" };
};
const opened = (userId: string, r: Row) =>
  decryptString({ encrypted: r.secret_ct, iv: r.secret_iv, authTag: r.secret_tag, kid: r.secret_kid || undefined }, userId);

async function factorRow(supabase: SupabaseClient, userId: string, kind: FactorKind): Promise<Row | null> {
  const { data, error } = await supabase.from("mfa_factors").select("*").eq("user_id", userId).eq("kind", kind).maybeSingle();
  if (error) throw error;
  return (data as Row | null) ?? null;
}

/**
 * (Re)starts a pending factor from the row as the caller read it; a confirmed
 * one stays until it is removed, which is itself a step-up. The write is
 * conditional on that row, so of two requests racing one writes and the
 * other gets "busy": a loser never wipes the code the winner mailed.
 */
async function begin(
  supabase: SupabaseClient,
  userId: string,
  kind: FactorKind,
  secret: string,
  existing: Row | null,
): Promise<"exists" | "busy" | Row> {
  if (existing?.confirmed_at) return "exists";
  const fresh = {
    ...sealed(userId, secret),
    created_at: new Date().toISOString(), confirmed_at: null, last_step: null, code_hash: null, code_expires_at: null,
    failed_attempts: 0, locked_until: null,
  };
  if (!existing) {
    const { data, error } = await supabase.from("mfa_factors").insert({ user_id: userId, kind, ...fresh }).select("*").single();
    if (error?.code === "23505") return "busy";
    if (error) throw error;
    return data as Row;
  }
  let again = supabase.from("mfa_factors").update(fresh).eq("id", existing.id).eq("secret_ct", existing.secret_ct).is("confirmed_at", null);
  again = existing.code_sent_at ? again.eq("code_sent_at", existing.code_sent_at) : again.is("code_sent_at", null);
  const { data, error } = await again.select("*").maybeSingle();
  if (error) throw error;
  return (data as Row | null) ?? "busy";
}

/** Starts enrolling an authenticator app: the secret and the otpauth URI for its QR code. */
export async function beginTotp(supabase: SupabaseClient, userId: string, label: string) {
  const secret = generateTotpSecret();
  const row = await begin(supabase, userId, "totp", secret, await factorRow(supabase, userId, "totp"));
  return row === "exists" || row === "busy" ? row : { secret, uri: otpauthUri(secret, label) };
}

/** Starts enrolling an email address: a code goes to it, and confirming that code proves the inbox. */
export async function beginEmail(supabase: SupabaseClient, userId: string, address: string): Promise<SendResult | "exists" | "busy"> {
  // A send the limits refuse leaves the pending row alone: re-beginning first
  // would wipe the code already mailed and answer 429 on top.
  const pending = await factorRow(supabase, userId, "email");
  const refused = pending && !pending.confirmed_at ? sendRefusal(pending, Date.now()) : null;
  if (refused) return refused;
  const row = await begin(supabase, userId, "email", address.trim().toLowerCase(), pending);
  // Only the request that wrote the row mails its code, from the row it wrote:
  // a loser, or a winner restarted before its send, would mail an address it
  // never stored and answer "sent".
  if (row === "exists" || row === "busy") return row;
  const sent = await sendEmailCode(supabase, userId, row);
  return sent === "cooldown" ? "busy" : sent;
}

/** Why no code may be sent now: one a minute, five a day. */
function sendRefusal(row: Row, now: number): "cooldown" | "daily_cap" | null {
  if (row.code_sent_at && now - Date.parse(row.code_sent_at) < RESEND_COOLDOWN_MS) return "cooldown";
  const today = new Date(now).toISOString().slice(0, 10);
  return (row.sends_day === today ? row.sends_count : 0) >= SENDS_PER_DAY ? "daily_cap" : null;
}

/**
 * Removes one factor, but never an embedded wallet's last (Kev, 2026-10-07):
 * the wallet JWT needs one, and a banned account cannot enroll a new one.
 * The last one is refused before anything is deleted, so no request ever
 * sees the account without a factor. Two removals racing past that check
 * count what is left after deleting, and one that finds nothing puts its
 * factor back; one that cannot count puts it back and reports the error.
 */
export async function removeFactor(
  supabase: SupabaseClient,
  userId: string,
  target: { passkey: string } | { kind: FactorKind },
): Promise<"removed" | "none" | "last"> {
  const { count: hasPassword, error: credErr } = await supabase
    .from("password_credentials")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (credErr) throw credErr;
  const key = "passkey" in target ? `passkey:${target.passkey}` : `code:${target.kind}`;
  if (hasPassword) {
    const before = await factorKeys(supabase, userId);
    if (before.length === 1 && before[0] === key) return "last";
  }
  const table = "passkey" in target ? "webauthn_credentials" : "mfa_factors";
  const del = supabase.from(table).delete().eq("user_id", userId);
  const { data: gone, error } = await ("passkey" in target ? del.eq("id", target.passkey) : del.eq("kind", target.kind)).select("*");
  if (error) throw error;
  if (!gone?.length) return "none";
  if (!hasPassword) return "removed";
  const putBack = async () => {
    const { error: back } = await supabase.from(table).insert(gone);
    if (back) {
      console.error(`[mfa] could not put back the last factor of ${userId} (${table}):`, back.message);
      throw back;
    }
  };
  let left: string[];
  try {
    left = await factorKeys(supabase, userId);
  } catch (e) {
    await putBack();
    throw e;
  }
  if (left.length) return "removed";
  await putBack();
  return "last";
}

/** The user's confirmed factors, one key each: every passkey, every confirmed code factor. */
async function factorKeys(supabase: SupabaseClient, userId: string): Promise<string[]> {
  const [passkeys, codes] = await Promise.all([
    supabase.from("webauthn_credentials").select("id").eq("user_id", userId),
    supabase.from("mfa_factors").select("kind").eq("user_id", userId).not("confirmed_at", "is", null),
  ]);
  if (passkeys.error) throw passkeys.error;
  if (codes.error && !missingTable(codes.error)) throw codes.error;
  return [
    ...((passkeys.data ?? []) as { id: string }[]).map((p) => `passkey:${p.id}`),
    ...((codes.data ?? []) as { kind: FactorKind }[]).map((c) => `code:${c.kind}`),
  ];
}

/**
 * A fresh code to the user's email factor, pending or confirmed. A new code
 * replaces the last. `begun` is the row a restart just wrote: the send is then
 * conditional on that row, not on a later read.
 */
export async function sendEmailCode(supabase: SupabaseClient, userId: string, begun?: Row): Promise<SendResult> {
  const row = begun ?? (await factorRow(supabase, userId, "email"));
  if (!row) return "none";
  const now = Date.now();
  const refused = sendRefusal(row, now);
  if (refused) return refused;
  const today = new Date(now).toISOString().slice(0, 10);
  const sent = row.sends_day === today ? row.sends_count : 0;
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  // Conditional on what was read: of parallel sends one wins, the rest wait
  // their minute, and a code is never written onto a re-begun address.
  let send = supabase
    .from("mfa_factors")
    .update({
      code_hash: codeHash(row.id, code),
      code_expires_at: new Date(now + CODE_TTL_MS).toISOString(),
      code_sent_at: new Date(now).toISOString(),
      sends_day: today,
      sends_count: sent + 1,
    })
    .eq("id", row.id)
    .eq("secret_ct", row.secret_ct);
  send = row.code_sent_at ? send.eq("code_sent_at", row.code_sent_at) : send.is("code_sent_at", null);
  const { data: won, error } = await send.select("id").maybeSingle();
  if (error) throw error;
  if (!won) return "cooldown";
  const mail = await sendMail({
    to: opened(userId, row),
    subject: "Your Enki verification code",
    text: `Your Enki verification code is ${code}. It is valid for 10 minutes.\n\nIf you did not ask for it, someone typed your address or is using your session: if you have an Enki account, sign out on every device and change your password.`,
  });
  return mail.ok ? "sent" : "send_failed";
}

/**
 * Checks a code against one of the user's factors. `confirm` also accepts a
 * pending factor and confirms it; otherwise only a confirmed factor counts.
 */
export async function checkCode(
  supabase: SupabaseClient,
  userId: string,
  kind: FactorKind,
  code: string,
  { confirm = false }: { confirm?: boolean } = {},
): Promise<CodeCheck> {
  const row = await factorRow(supabase, userId, kind);
  if (!row || (!confirm && !row.confirmed_at)) return "none";
  const now = Date.now();
  if (!row.confirmed_at && Date.parse(row.created_at) + SETUP_TTL_MS < now) return "none";
  if ((row.locked_until && Date.parse(row.locked_until) > now) || row.failed_attempts >= MAX_ATTEMPTS) return "locked";

  // The attempt is spent before the code is looked at, against the row as it
  // was read: a parallel request, a lock written meanwhile or a re-begun
  // secret makes the claim miss.
  const tries = row.failed_attempts + 1;
  const { data: claimed, error } = await supabase
    .from("mfa_factors")
    .update({ failed_attempts: tries })
    .eq("id", row.id)
    .eq("failed_attempts", row.failed_attempts)
    .eq("secret_ct", row.secret_ct)
    .or(`locked_until.is.null,locked_until.lte.${new Date(now).toISOString()}`)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!claimed) return "busy";

  const clean = String(code ?? "").replace(/\D/g, "");
  let step: number | null = null;
  let ok: boolean;
  if (kind === "totp") {
    step = totpStep(opened(userId, row), clean);
    ok = step !== null && (row.last_step === null || step > Number(row.last_step));
  } else {
    ok = clean.length === 6 && !!row.code_hash && !!row.code_expires_at && Date.parse(row.code_expires_at) > now
      && crypto.timingSafeEqual(Buffer.from(codeHash(row.id, clean), "hex"), Buffer.from(row.code_hash, "hex"));
  }

  const stamp = new Date(now).toISOString();
  if (ok) {
    // Spends the code: of two requests carrying it, only one lands here.
    let spend = supabase
      .from("mfa_factors")
      .update({
        failed_attempts: 0, lockouts: 0, locked_until: null, last_used_at: stamp,
        ...(row.confirmed_at ? {} : { confirmed_at: stamp }),
        ...(kind === "totp" ? { last_step: step } : { code_hash: null, code_expires_at: null }),
      })
      .eq("id", row.id)
      // The secret the code was checked against: a restart in between must not get confirmed by it.
      .eq("secret_ct", row.secret_ct);
    spend = kind === "totp"
      ? spend.or(`last_step.is.null,last_step.lt.${step}`)
      : spend.eq("code_hash", row.code_hash as string);
    const { data: spent, error: e } = await spend.select("id").maybeSingle();
    if (e) throw e;
    return spent ? "ok" : "wrong";
  }
  if (tries >= MAX_ATTEMPTS) {
    const { error: e } = await supabase
      .from("mfa_factors")
      .update({
        failed_attempts: 0,
        lockouts: row.lockouts + 1,
        locked_until: new Date(now + Math.min(LOCK_BASE_MS * 2 ** row.lockouts, LOCK_MAX_MS)).toISOString(),
      })
      .eq("id", row.id);
    if (e) throw e;
    return "locked";
  }
  return "wrong";
}
