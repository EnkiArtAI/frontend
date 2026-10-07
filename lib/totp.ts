/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30s) — for the "Authenticator" guardian type.
 * Uses node crypto only (no new dependency). Secrets are base32 so any standard
 * authenticator app (Google Authenticator, Authy, 1Password…) can scan them.
 */
import crypto from "crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD = 30;
const DIGITS = 6;
export const TOTP_ISSUER = "Enki Art";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A fresh 20-byte secret, base32-encoded. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** otpauth:// URI for the QR code. label = what shows in the user's app. */
export function otpauthUri(secretB32: string, label: string): string {
  const acct = encodeURIComponent(label || "account");
  const iss = encodeURIComponent(TOTP_ISSUER);
  return `otpauth://totp/${iss}:${acct}?secret=${secretB32}&issuer=${iss}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secret).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return (code % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/**
 * The 30s step `code` belongs to (current window ±1 for clock drift), or
 * null. A factor stores the last step it accepted, so the same code cannot
 * be used twice inside its window.
 */
export function totpStep(secretB32: string, code: string): number | null {
  const clean = String(code ?? "").replace(/\D/g, "");
  if (clean.length !== DIGITS) return null;
  const secret = base32Decode(secretB32);
  if (secret.length === 0) return null;
  const counter = Math.floor(Date.now() / 1000 / PERIOD);
  for (let w = -1; w <= 1; w++) {
    // Constant-time compare to avoid leaking match position via timing.
    const cand = hotp(secret, counter + w);
    if (crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(clean))) return counter + w;
  }
  return null;
}

/** True if `code` matches the current 30s window (±1 for clock drift). */
export function verifyTotp(secretB32: string, code: string): boolean {
  return totpStep(secretB32, code) !== null;
}

/** The code for a step: what an authenticator app shows (tests use it). */
export function totpCode(secretB32: string, step = Math.floor(Date.now() / 1000 / PERIOD)): string {
  return hotp(base32Decode(secretB32), step);
}
