/**
 * Shared password-reset core: sets the new Argon2id+pepper password, evicts
 * EVERY existing session (a reset must lock out anyone already in), and logs
 * the user in. Used by the email-code flow and the guardian-recovery flow.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { hashPassword } from "@/lib/password-auth";
import { mintUserSession } from "@/lib/user-session";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Random n-digit numeric code (crypto-strong). */
export function numericCode(digits = 7): string {
  const { randomInt } = require("crypto") as typeof import("crypto");
  return String(randomInt(10 ** (digits - 1), 10 ** digits));
}

/** inboxProven: the reset came through the account's inbox (the emailed
    code), so the email counts as confirmed and a one-time password is gone.
    A guardian recovery proves no inbox and leaves both as they are.
    ipHash: the network of a reset that ends in a login, for IP bans. */
export async function completePasswordReset(
  supabase: SupabaseClient,
  userId: string,
  password: string,
  { inboxProven = false, ipHash = null as string | null } = {},
): Promise<{ email?: string; token: string; expiresAt: string } | { error: string }> {
  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("password_credentials")
    .update({ pw_hash: hash, pw_salt: salt, updated_at: now, ...(inboxProven ? { email_verified_at: now, must_change_password: false } : {}) })
    .eq("user_id", userId)
    .select("email")
    .single();
  if (error) {
    console.error("[password-reset] update failed:", error.message);
    return { error: "Could not reset password" };
  }

  // Sessions key on the users.id bridge before a wallet is attached and on the
  // wallet address after — evict both.
  const { data: wallets } = await supabase
    .from("user_wallets")
    .select("address")
    .eq("user_id", userId)
    .is("removed_at", null);
  const keys = [userId, ...(wallets ?? []).map((w) => w.address)];
  await supabase.from("auth_sessions").delete().in("wallet_address", keys);

  const session = await mintUserSession(userId, ipHash);
  return { email: updated?.email ?? undefined, ...session };
}
