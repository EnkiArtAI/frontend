/**
 * Private-beta access (Kev, 2026-10-07). An admin approves an access request,
 * or invites an email or a wallet directly.
 *
 * - An email goes on the access list and gets an account (role beta) with a
 *   one-time password, mailed to it. That password opens only the step that
 *   replaces it (/api/auth/password/first-login), which also confirms the
 *   email; the wallet waits for that step. It never expires (Kev), so it
 *   carries 100 bits: 20 characters from a 32-letter alphabet.
 * - A wallet goes on the access list; it logs in by its own signature.
 *
 * Inviting an email again mails a fresh one-time password while the account
 * has not chosen its own; one that has is left alone. The one-time password
 * appears in the mail body only: never in a subject, a log or a response.
 */
import { randomInt } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { sendMail } from "@/lib/mailer";

type Supabase = ReturnType<typeof getSupabaseServerClient>;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
// The check every login and reset route makes: an invitee must be able to use them.
const EMAIL = z.string().email().max(254);

/** A refusal the admin sees as it is. */
export class AccessError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function oneTimePassword(): string {
  return Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

function inviteMail(email: string, password: string) {
  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://enki.gallery";
  return {
    to: email,
    subject: "You're in: your Enki Art access",
    text:
      `Welcome to Enki Art. Your access is approved.\n\n` +
      `Log in at ${origin} with\n\n    email: ${email}\n    one-time password: ${password}\n\n` +
      `You'll choose your own password right away; the one-time password stops working then, ` +
      `and your wallet opens after that step.\n\n` +
      `If you didn't ask for access, you can ignore this email.`,
  };
}

/** Puts one value on the access list; true when it was not there yet. */
async function allow(supabase: Supabase, kind: "email" | "wallet", value: string, note: string): Promise<boolean> {
  const { error } = await supabase.from("access_allowlist").insert({ kind, value, note });
  if (!error) return true;
  if (error.code === "23505") return false; // unique (kind, lower(value)): listed already
  throw new AccessError("Could not update the access list", 503);
}

export type EmailInvite = { outcome: "invited" | "reinvited" | "has-password"; mailed: boolean };

export async function inviteEmail(supabase: Supabase, raw: string): Promise<EmailInvite> {
  const email = raw.trim().toLowerCase();
  if (!EMAIL.safeParse(email).success) throw new AccessError("Enter a valid email address");
  await allow(supabase, "email", email, "invited");
  // A direct invite settles this email's open request too: approving it
  // later would mail a second password and void the first.
  await supabase.from("access_requests").update({ status: "approved", updated_at: new Date().toISOString() }).eq("email", email).eq("status", "pending");

  const { data: cred, error } = await supabase
    .from("password_credentials")
    .select("user_id")
    .eq("email", email)
    .maybeSingle();
  if (error) throw new AccessError("Could not read the account", 503);

  const password = oneTimePassword();
  // Loaded here, not at the top: it needs the pepper at load, and the admin
  // route (which imports this module) must load without it.
  const { hashPassword } = await import("@/lib/password-auth");
  const { hash, salt } = hashPassword(password);
  let outcome: EmailInvite["outcome"] = "invited";
  if (cred) {
    // Only a one-time password is renewed, never one the user chose.
    const { data: renewed, error: updErr } = await supabase
      .from("password_credentials")
      .update({ pw_hash: hash, pw_salt: salt, updated_at: new Date().toISOString() })
      .eq("user_id", cred.user_id)
      .eq("must_change_password", true)
      .select("user_id");
    if (updErr) throw new AccessError("Could not renew the one-time password", 503);
    if (!renewed?.length) return { outcome: "has-password", mailed: false };
    outcome = "reinvited";
  } else {
    const { data: user, error: userErr } = await supabase
      .from("users")
      .insert({ account_status: "active", role: "beta" })
      .select("id")
      .single();
    if (userErr || !user) throw new AccessError("Could not create the account", 503);
    const { error: credErr } = await supabase.from("password_credentials").insert({
      user_id: user.id, email, pw_hash: hash, pw_salt: salt, must_change_password: true,
    });
    if (credErr) {
      await supabase.from("users").delete().eq("id", user.id);
      throw credErr.code === "23505"
        ? new AccessError("Another invite for this email is running. Try again.", 409)
        : new AccessError("Could not create the account", 503);
    }
  }
  const mailed = (await sendMail(inviteMail(email, password)).catch(() => ({ ok: false }))).ok;
  // The access list keeps whether the password reached them, for a resend.
  await supabase.from("access_allowlist").update({ note: mailed ? "invited" : "invited, mail not sent" }).eq("kind", "email").eq("value", email);
  return { outcome, mailed };
}

export async function inviteWallet(supabase: Supabase, raw: string): Promise<{ listed: boolean }> {
  const address = raw.trim();
  let valid = /^0x[0-9a-fA-F]{40}$/.test(address);
  if (!valid) {
    try { valid = Boolean(new PublicKey(address)); } catch { valid = false; }
  }
  if (!valid) throw new AccessError("Enter a Solana or EVM wallet address");
  return { listed: await allow(supabase, "wallet", address, "invited") };
}

/** Approves a pending access request: claimed first, so a double click or a
    second admin mails nothing twice; its email is then invited. A failed
    invite puts the request back. */
export async function approveRequest(supabase: Supabase, id: string): Promise<EmailInvite> {
  const { data: claimed, error } = await supabase
    .from("access_requests")
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("email");
  if (error) throw new AccessError("Could not read the request", 503);
  if (!claimed?.length) throw new AccessError("No pending request with this id", 404);
  try {
    return await inviteEmail(supabase, String(claimed[0].email));
  } catch (e) {
    await supabase.from("access_requests").update({ status: "pending" }).eq("id", id);
    throw e;
  }
}

/** The Access tab's data, for admins only: it holds applicants' emails. */
export function accessFor(supabase: Supabase, role: string) {
  return role === "admin" ? loadAccess(supabase) : Promise.resolve(null);
}

/** What the admin's Access tab shows: pending requests and the access list. */
export async function loadAccess(supabase: Supabase) {
  const [requests, allowlist] = await Promise.all([
    supabase.from("access_requests").select("id, email, about, socials, created_at").eq("status", "pending").order("created_at", { ascending: false }),
    supabase.from("access_allowlist").select("id, kind, value, note, created_at").order("created_at", { ascending: false }),
  ]);
  return { requests: requests.data ?? [], allowlist: allowlist.data ?? [] };
}
