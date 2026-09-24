/**
 * Environment file handling for scripts/db-copy.mjs. Pure: text in, text out.
 * Values are never logged by anything in this module; callers print names.
 */

export type Env = Record<string, string>;

/** KEY=value lines; comments and blanks ignored, surrounding quotes stripped. */
export function parseEnv(text: string): Env {
  const env: Env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    env[m[1]] = value;
  }
  return env;
}

/** Replace the KEY= line (whatever it held, PASTE marker included) or append it. */
export function upsertEnv(text: string, values: Env): string {
  const lines = text.split(/\r?\n/);
  const pending = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !pending.has(m[1])) return line;
    const v = pending.get(m[1]);
    pending.delete(m[1]);
    return `${m[1]}=${v}`;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  return out.join("\n") + "\n";
}

/** The 20 letter project ref in https://<ref>.supabase.co. */
export function projectRef(url: string | undefined): string {
  let host = "";
  try { host = new URL(url ?? "").host; } catch { /* reported below */ }
  const ref = host.split(".")[0];
  if (!/^[a-z]{20}$/.test(ref) || !host.endsWith(".supabase.co")) {
    throw new Error("SUPABASE_URL must look like https://<20 letter ref>.supabase.co.");
  }
  return ref;
}

/** Where each input comes from, spelled out once so every error sentence agrees. */
export const INPUT_HINTS: Record<string, string> = {
  SUPABASE_ACCESS_TOKEN: "a personal access token from https://supabase.com/dashboard/account/tokens",
  SUPABASE_URL: "the live project URL, Settings > API",
  SUPABASE_DB_PASSWORD: "the live database password, Settings > Database",
  FIELD_ENCRYPTION_KEY_B64: "the live encryption key (Vercel project settings)",
  AUTH_PEPPER: "the live pepper (Vercel project settings)",
};

/** One sentence per missing input, in the order given. */
export function missingInputs(env: Env, names: string[], file: string): string[] {
  return names
    .filter((n) => !env[n]?.trim())
    .map((n) => `${n} is missing from ${file}${INPUT_HINTS[n] ? `: ${INPUT_HINTS[n]}` : ""}.`);
}

/** A database password without URL or shell special characters, 32 characters. */
export function generateDbPassword(randomBytes: (n: number) => Uint8Array): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const unbiased = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < 32) {
    for (const b of randomBytes(64)) if (b < unbiased && out.length < 32) out += alphabet[b % alphabet.length];
  }
  return out;
}
