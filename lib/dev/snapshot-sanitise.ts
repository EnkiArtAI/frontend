/**
 * Pure transformation rules for the developer copy of the live database.
 *
 * scripts/db-copy.mjs loads schema and data into a second Supabase project with
 * pg_dump and psql, then reads every row of the copy over PostgREST, pushes it
 * through `sanitiseTable` and PATCHes what changed back by primary key. Nothing
 * here touches the network or the file system, so every rule is unit tested
 * against fixtures. Erasable TypeScript only: Node strips the types when the
 * script imports this file directly.
 *
 * Rules, in the order they run per row:
 *   1. emptied tables (sessions, nonces, tokens) keep their structure only
 *   2. encryption envelopes (X_ct/X_iv/X_tag/X_kid and prompts.encrypted_content)
 *      are opened with the production key ring and sealed again with the dev key;
 *      email envelopes are replaced by a sealed pseudonym; last_seen_ip is dropped
 *   3. plaintext email columns become the same pseudonym, lookup hashes follow
 *   4. token and ip hash columns are nulled (a primary key gets a one way hash)
 *   5. password_credentials receive the fixed dev password
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { argon2id } from "@noble/hashes/argon2";

export type ColumnSpec = { name: string; format: string; pk: boolean };
export type TableSpec = { name: string; columns: ColumnSpec[] };
export type Row = Record<string, unknown>;
export type KeyEntry = { kid: string; key: Buffer };

export type SanitiseContext = {
  prodKeys: KeyEntry[];
  devKey: Buffer;
  devPepperB64: string;
  /** Filled lazily: one Argon2id derivation per run, reused for every credential row. */
  devCredential?: { hash: string; salt: string };
};

export type TableStats = {
  table: string;
  rows: number;
  rekeyed: number;
  decryptFailures: number;
  pseudonyms: number;
  emptied: boolean;
};

export const DEV_PASSWORD = "enki-dev-password";
export const DEV_KID = "field-v1";

/** Session and token tables: structure only, a developer mints their own. */
export const EMPTIED_TABLES: readonly string[] = [
  "auth_sessions",
  "auth_nonces",
  "otp_sessions",
  "password_reset_tokens",
  "delete_confirm_tokens",
  "deletion_approvals",
  "user_sessions",
];

/**
 * Envelopes that hold an email address: the plaintext is not needed, the
 * pseudonym is sealed in its place with the AAD the reading code expects.
 * Verified against the call sites on 2026-09-24: recovery guardians and admin
 * prefs bind to the user id, the others read without AAD.
 */
const EMAIL_ENVELOPES: Record<string, "user_id" | null> = {
  "users.email": null,
  "feedback_submissions.submitter_email": null,
  "recovery_requests.claimed_email": null,
  "recovery_requests.contact_email": null,
  "admin_prefs.notify_email": "user_id",
  "recovery_guardians.guardian_value": "user_id",
};

/** Envelopes dropped outright. */
const DROPPED_ENVELOPES = new Set(["user_authenticators.last_seen_ip"]);

/** The id a pseudonym is derived from, first match wins. */
const PSEUDONYM_ID_COLUMNS: Record<string, string[]> = {
  recovery_guardians: ["guardian_user_id", "id"],
};
const DEFAULT_ID_COLUMNS = ["user_id", "id"];

const TOKEN_COLUMN = /^(.*_)?token(_hash)?$/;
const IP_HASH_COLUMN = /(^|_)ip_hash$/;
const EMAIL_COLUMN = /(^|_)email$/;
const LOOKUP_HASH_COLUMN = /_lookup_hash$/;

/** Argon2id parameters, identical to lib/password-auth.ts (proven by test). */
const KDF = { t: 3, m: 65536, p: 1, dkLen: 32 } as const;

// ---------------------------------------------------------------- discovery

/** Tables and columns from the PostgREST OpenAPI document at /rest/v1/. */
export function parseOpenApi(spec: { definitions?: Record<string, { properties?: Record<string, { type?: string; format?: string; description?: string }> }> }): TableSpec[] {
  return Object.entries(spec.definitions ?? {}).map(([name, def]) => ({
    name,
    columns: Object.entries(def.properties ?? {}).map(([col, p]) => ({
      name: col,
      format: p.format ?? p.type ?? "text",
      pk: /<pk\/>/.test(p.description ?? ""),
    })),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Tables and columns from information_schema rows (table_name, column_name, udt_name, pk). */
export function tablesFromColumns(rows: { table_name: string; column_name: string; udt_name: string; pk: boolean }[]): TableSpec[] {
  const byName = new Map<string, TableSpec>();
  for (const r of rows) {
    const t = byName.get(r.table_name) ?? { name: r.table_name, columns: [] };
    t.columns.push({ name: r.column_name, format: r.udt_name, pk: r.pk });
    byName.set(r.table_name, t);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Ranges for PostgREST pagination: 0-999, 1000-1999, ... until a short page. */
export async function paginate<T>(fetchPage: (from: number, to: number) => Promise<T[]>, pageSize = 1000): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/** The production key ring exactly as lib/crypto.ts assembles it from the environment. */
export function keyringFromEnv(env: Record<string, string | undefined>): KeyEntry[] {
  const parse = (b64: string, label: string) => {
    const key = Buffer.from(b64.trim(), "base64");
    if (key.length !== 32) throw new Error(`${label} must decode to 32 bytes.`);
    return key;
  };
  if (!env.FIELD_ENCRYPTION_KEY_B64) throw new Error("FIELD_ENCRYPTION_KEY_B64 is missing from .env.local.");
  const ring: KeyEntry[] = [{ kid: DEV_KID, key: parse(env.FIELD_ENCRYPTION_KEY_B64, "FIELD_ENCRYPTION_KEY_B64") }];
  for (const part of (env.FIELD_ENCRYPTION_KEYS_RETIRED ?? "").split(",")) {
    const [kid, b64] = part.split(":");
    if (kid?.trim() && b64?.trim()) ring.push({ kid: kid.trim(), key: parse(b64, `retired key ${kid.trim()}`) });
  }
  if (env.PROMPT_ENCRYPTION_KEY) ring.push({ kid: "prompt-legacy", key: parse(env.PROMPT_ENCRYPTION_KEY, "PROMPT_ENCRYPTION_KEY") });
  return ring;
}

// ---------------------------------------------------------------- envelopes

export type Envelope = { family: string; ct: string; iv: string; tag: string; kid: string | null };

/** X_ct/X_iv/X_tag(/X_kid) families, plus prompts.encrypted_content(_iv/_tag/_kid). */
export function envelopeFamilies(columns: string[]): Envelope[] {
  const has = new Set(columns);
  const out: Envelope[] = [];
  for (const col of columns) {
    if (!col.endsWith("_iv")) continue;
    const family = col.slice(0, -3);
    const ct = has.has(`${family}_ct`) ? `${family}_ct` : has.has(family) ? family : null;
    if (!ct || !has.has(`${family}_tag`)) continue;
    out.push({ family, ct, iv: col, tag: `${family}_tag`, kid: has.has(`${family}_kid`) ? `${family}_kid` : null });
  }
  return out;
}

export type Sealed = { ct: string; iv: string; tag: string; kid: string };

/** Decrypt with the named key, or with every key when the row carries no kid. */
export function openEnvelope(payload: { ct: string; iv: string; tag: string; kid?: string | null }, keys: KeyEntry[], aad?: string): string {
  const candidates = payload.kid ? keys.filter((k) => k.kid === payload.kid) : keys;
  let lastError: unknown = new Error("no key");
  for (const entry of candidates) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", entry.key, Buffer.from(payload.iv, "base64"));
      if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(payload.ct, "base64")), decipher.final()]).toString("utf8");
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/** Same wire format lib/crypto.ts writes: 12 byte IV, kid field-v1. */
export function sealEnvelope(plaintext: string, key: Buffer, aad?: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ct: ct.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), kid: DEV_KID };
}

/** The AADs production code has written envelopes with: none, the user id, the intent binding. */
function aadCandidates(row: Row): (string | undefined)[] {
  const out: (string | undefined)[] = [undefined];
  if (typeof row.user_id === "string") out.push(row.user_id);
  if (typeof row.id === "string") out.push(`intent:${row.id}`);
  return out;
}

/** Open with production keys, seal with the dev key, keeping the AAD that opened it. Null on failure. */
export function rekeyEnvelope(payload: { ct: string; iv: string; tag: string; kid?: string | null }, row: Row, ctx: SanitiseContext): Sealed | null {
  for (const aad of aadCandidates(row)) {
    try {
      return sealEnvelope(openEnvelope(payload, ctx.prodKeys, aad), ctx.devKey, aad);
    } catch {
      /* next AAD */
    }
  }
  return null;
}

// ---------------------------------------------------------------- identities

export function pseudonym(row: Row, table: string): string {
  for (const col of PSEUDONYM_ID_COLUMNS[table] ?? DEFAULT_ID_COLUMNS) {
    const v = row[col];
    if (typeof v === "string" && v) return `user-${v.slice(0, 8)}@example.test`;
  }
  return "user-unknown@example.test";
}

/**
 * Mirrors the only writer of a lookup hash in the app, app/api/feedback/route.ts:
 * sha256 of the lowercased address, no pepper. The register route stores the
 * plaintext address in password_credentials.email and writes no hash at all.
 */
export const emailLookupHash = (email: string): string => createHash("sha256").update(email.toLowerCase()).digest("hex");

/** Argon2id with the dev pepper, exactly as lib/password-auth.ts derives (proven by test against verifyPassword). */
export function devPasswordCredential(password: string, pepperB64: string): { hash: string; salt: string } {
  const pepper = Buffer.from(pepperB64, "base64");
  if (pepper.length !== 32) throw new Error("dev AUTH_PEPPER must decode to 32 bytes");
  const salt = randomBytes(16);
  const hash = argon2id(new TextEncoder().encode(password), salt, { ...KDF, key: pepper });
  return { hash: Buffer.from(hash).toString("base64"), salt: salt.toString("base64") };
}

export const isRedactedColumn = (name: string): boolean => TOKEN_COLUMN.test(name) || IP_HASH_COLUMN.test(name);

const oneWay = (v: unknown) => createHash("sha256").update(String(v)).digest("hex");

// ---------------------------------------------------------------- per table

/** Whether any rule can touch this table; tables that need nothing are never read. */
export function tableNeedsSanitising(table: TableSpec): boolean {
  if (EMPTIED_TABLES.includes(table.name) || table.name === "password_credentials" || table.name === "recovery_guardians") return true;
  const names = table.columns.map((c) => c.name);
  return envelopeFamilies(names).length > 0 || names.some((c) => EMAIL_COLUMN.test(c) || LOOKUP_HASH_COLUMN.test(c) || isRedactedColumn(c));
}

export function sanitiseTable(table: TableSpec, rows: Row[], ctx: SanitiseContext): { rows: Row[]; stats: TableStats } {
  const stats: TableStats = { table: table.name, rows: 0, rekeyed: 0, decryptFailures: 0, pseudonyms: 0, emptied: false };
  if (EMPTIED_TABLES.includes(table.name)) return { rows: [], stats: { ...stats, emptied: true } };

  const columns = table.columns.map((c) => c.name);
  const pk = new Set(table.columns.filter((c) => c.pk).map((c) => c.name));
  const envelopes = envelopeFamilies(columns);
  const envelopeColumns = new Set(envelopes.flatMap((e) => [e.ct, e.iv, e.tag, e.kid].filter((c): c is string => !!c)));
  const out: Row[] = [];

  for (const src of rows) {
    const row: Row = { ...src };
    const alias = pseudonym(row, table.name);
    let usedAlias = false;

    for (const env of envelopes) {
      const key = `${table.name}.${env.family}`;
      const write = (sealed: Sealed | null) => {
        row[env.ct] = sealed?.ct ?? null;
        row[env.iv] = sealed?.iv ?? null;
        row[env.tag] = sealed?.tag ?? null;
        if (env.kid) row[env.kid] = sealed?.kid ?? null;
      };
      if (DROPPED_ENVELOPES.has(key)) { write(null); continue; }
      const empty = typeof row[env.ct] !== "string" || !row[env.ct];
      if (key in EMAIL_ENVELOPES) {
        if (empty) continue;
        const aadCol = EMAIL_ENVELOPES[key];
        write(sealEnvelope(alias, ctx.devKey, aadCol ? String(row[aadCol]) : undefined));
        usedAlias = true;
        continue;
      }
      if (empty) continue;
      const sealed = rekeyEnvelope(
        { ct: row[env.ct] as string, iv: String(row[env.iv]), tag: String(row[env.tag]), kid: env.kid ? (row[env.kid] as string | null) : null },
        row,
        ctx,
      );
      write(sealed);
      if (sealed) stats.rekeyed++; else stats.decryptFailures++;
    }

    for (const col of columns) {
      if (envelopeColumns.has(col)) continue;
      const v = row[col];
      if (EMAIL_COLUMN.test(col) && typeof v === "string") { row[col] = alias; usedAlias = true; continue; }
      if (table.name === "recovery_guardians" && col === "value" && row.guardian_type === "email" && typeof v === "string") { row[col] = alias; usedAlias = true; continue; }
      if (LOOKUP_HASH_COLUMN.test(col) && typeof v === "string") { row[col] = emailLookupHash(alias); continue; }
      if (isRedactedColumn(col) && v != null) row[col] = pk.has(col) ? oneWay(v) : null;
    }

    if (table.name === "password_credentials") {
      ctx.devCredential ??= devPasswordCredential(DEV_PASSWORD, ctx.devPepperB64);
      row.pw_hash = ctx.devCredential.hash;
      row.pw_salt = ctx.devCredential.salt;
    }

    if (usedAlias) stats.pseudonyms++;
    out.push(row);
  }
  stats.rows = out.length;
  return { rows: out, stats };
}

// ---------------------------------------------------------------- PATCH plan

export type RowPatch = { filter: Record<string, unknown>; body: Row };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What one PostgREST PATCH must carry to turn `before` into `after`: only the
 * changed columns, addressed by the primary key as it was before the change
 * (a redacted primary key changes value). Null when nothing changed.
 */
export function rowPatch(table: TableSpec, before: Row, after: Row): RowPatch | null {
  const body: Row = {};
  for (const c of table.columns) if (!same(before[c.name], after[c.name])) body[c.name] = after[c.name];
  if (Object.keys(body).length === 0) return null;
  const keyColumns = table.columns.filter((c) => c.pk);
  if (keyColumns.length === 0) throw new Error(`Table ${table.name} has no primary key, so its rows cannot be patched one by one.`);
  return { filter: Object.fromEntries(keyColumns.map((c) => [c.name, before[c.name]])), body };
}
