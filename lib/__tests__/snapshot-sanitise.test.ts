import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import {
  DEV_PASSWORD,
  EMPTIED_TABLES,
  emailLookupHash,
  envelopeFamilies,
  keyringFromEnv,
  openEnvelope,
  paginate,
  parseOpenApi,
  pseudonym,
  rowPatch,
  sanitiseTable,
  sealEnvelope,
  tableNeedsSanitising,
  tablesFromColumns,
  type KeyEntry,
  type Row,
  type SanitiseContext,
  type TableSpec,
} from "@/lib/dev/snapshot-sanitise";

/**
 * The dev copy of the live database is only safe if every rule here holds:
 * a missed envelope leaks a production ciphertext that the dev key cannot open,
 * a missed email column leaks a real address, a missed token column hands a
 * developer a live session. Each rule is exercised against a fixture row shaped
 * like the live table (probed over PostgREST on 2026-09-24).
 */

const KEY_A: KeyEntry = { kid: "field-v1", key: randomBytes(32) };
const KEY_RETIRED: KeyEntry = { kid: "field-v0", key: randomBytes(32) };
const DEV_KEY = randomBytes(32);
const DEV_PEPPER = randomBytes(32).toString("base64");
const UUID = "3f9d2c10-7a4b-4e2e-9c1d-0a1b2c3d4e5f";
const OTHER = "9b8a7c6d-1234-4abc-8def-fedcba987654";

const ctx = (): SanitiseContext => ({ prodKeys: [KEY_A, KEY_RETIRED], devKey: DEV_KEY, devPepperB64: DEV_PEPPER });

const table = (name: string, cols: (string | [string, string] | [string, string, "pk"])[]): TableSpec => ({
  name,
  columns: cols.map((c) => (typeof c === "string" ? { name: c, format: "text", pk: c === "id" } : { name: c[0], format: c[1], pk: c[2] === "pk" || c[0] === "id" })),
});

const sealedWith = (key: KeyEntry, plaintext: string, aad?: string) => {
  const s = sealEnvelope(plaintext, key.key, aad);
  return { ...s, kid: key.kid };
};

describe("envelope re-key", () => {
  const generations = table("generations", ["id", "user_id", "final_prompt_ct", "final_prompt_iv", "final_prompt_tag", "final_prompt_kid", "provider"]);

  it("decrypts with the production key, seals with the dev key, dev key opens the plaintext", () => {
    const s = sealedWith(KEY_A, "a scribe at dusk");
    const row: Row = { id: UUID, user_id: OTHER, final_prompt_ct: s.ct, final_prompt_iv: s.iv, final_prompt_tag: s.tag, final_prompt_kid: s.kid, provider: "gemini" };
    const { rows, stats } = sanitiseTable(generations, [row], ctx());
    const out = rows[0];
    expect(out.final_prompt_ct).not.toBe(s.ct);
    expect(out.final_prompt_kid).toBe("field-v1");
    const opened = openEnvelope({ ct: String(out.final_prompt_ct), iv: String(out.final_prompt_iv), tag: String(out.final_prompt_tag), kid: "field-v1" }, [{ kid: "field-v1", key: DEV_KEY }]);
    expect(opened).toBe("a scribe at dusk");
    expect(() => openEnvelope({ ct: String(out.final_prompt_ct), iv: String(out.final_prompt_iv), tag: String(out.final_prompt_tag), kid: "field-v1" }, [KEY_A])).toThrow();
    expect(stats).toMatchObject({ rekeyed: 1, decryptFailures: 0 });
  });

  it("opens a retired key by kid and a kid-less legacy row by trying every key", () => {
    const retired = sealedWith(KEY_RETIRED, "old prompt");
    const legacy = { ...sealedWith(KEY_RETIRED, "very old prompt"), kid: null };
    const rows = [retired, legacy].map((s, i) => ({ id: `${i}${UUID.slice(1)}`, user_id: OTHER, final_prompt_ct: s.ct, final_prompt_iv: s.iv, final_prompt_tag: s.tag, final_prompt_kid: s.kid, provider: "x" }));
    const { rows: out, stats } = sanitiseTable(generations, rows, ctx());
    const dev = [{ kid: "field-v1", key: DEV_KEY }];
    expect(openEnvelope({ ct: String(out[0].final_prompt_ct), iv: String(out[0].final_prompt_iv), tag: String(out[0].final_prompt_tag) }, dev)).toBe("old prompt");
    expect(openEnvelope({ ct: String(out[1].final_prompt_ct), iv: String(out[1].final_prompt_iv), tag: String(out[1].final_prompt_tag) }, dev)).toBe("very old prompt");
    expect(stats.rekeyed).toBe(2);
  });

  it("keeps the AAD binding: an intent's signed tx opens only under intent:<id>", () => {
    const intents = table("generation_payment_intents", ["id", "buyer_wallet", "authorized_tx_ct", "authorized_tx_iv", "authorized_tx_tag", "authorized_tx_kid"]);
    const s = sealedWith(KEY_A, "signed-tx-bytes", `intent:${UUID}`);
    const { rows } = sanitiseTable(intents, [{ id: UUID, buyer_wallet: "w", authorized_tx_ct: s.ct, authorized_tx_iv: s.iv, authorized_tx_tag: s.tag, authorized_tx_kid: s.kid }], ctx());
    const p = { ct: String(rows[0].authorized_tx_ct), iv: String(rows[0].authorized_tx_iv), tag: String(rows[0].authorized_tx_tag) };
    const dev = [{ kid: "field-v1", key: DEV_KEY }];
    expect(openEnvelope(p, dev, `intent:${UUID}`)).toBe("signed-tx-bytes");
    expect(() => openEnvelope(p, dev)).toThrow();
  });

  it("an envelope no key opens becomes null in every column and is counted, never copied", () => {
    const stranger = sealedWith({ kid: "field-v1", key: randomBytes(32) }, "unreadable");
    const row: Row = { id: UUID, user_id: OTHER, final_prompt_ct: stranger.ct, final_prompt_iv: stranger.iv, final_prompt_tag: stranger.tag, final_prompt_kid: "field-v1", provider: "gemini" };
    const { rows, stats } = sanitiseTable(generations, [row], ctx());
    expect(rows[0]).toMatchObject({ final_prompt_ct: null, final_prompt_iv: null, final_prompt_tag: null, final_prompt_kid: null, provider: "gemini" });
    expect(stats).toMatchObject({ rekeyed: 0, decryptFailures: 1 });
  });

  it("an empty envelope stays empty and counts as nothing", () => {
    const row: Row = { id: UUID, user_id: OTHER, final_prompt_ct: null, final_prompt_iv: null, final_prompt_tag: null, final_prompt_kid: null, provider: "gemini" };
    const { rows, stats } = sanitiseTable(generations, [row], ctx());
    expect(rows[0].final_prompt_ct).toBeNull();
    expect(stats).toMatchObject({ rekeyed: 0, decryptFailures: 0 });
  });

  it("detects prompts.encrypted_content as a family without the _ct suffix", () => {
    const fams = envelopeFamilies(["id", "encrypted_content", "encrypted_content_iv", "encrypted_content_tag", "encrypted_content_kid", "title"]);
    expect(fams).toEqual([{ family: "encrypted_content", ct: "encrypted_content", iv: "encrypted_content_iv", tag: "encrypted_content_tag", kid: "encrypted_content_kid" }]);
    expect(envelopeFamilies(["foo_iv", "foo_tag"])).toEqual([]);
  });

  it("a prompt's other columns come through untouched while its body is re-keyed", () => {
    const prompts = table("prompts", ["id", "creator_id", "title", ["tags", "text[]"], ["ai_settings", "jsonb"], ["price_usd_cents", "integer"], "encrypted_content", "encrypted_content_iv", "encrypted_content_tag", "encrypted_content_kid"]);
    const s = sealedWith(KEY_A, "the secret prompt body");
    const src: Row = { id: UUID, creator_id: OTHER, title: "Sumer at dusk", tags: ["a", "b"], ai_settings: { steps: 20 }, price_usd_cents: 500, encrypted_content: s.ct, encrypted_content_iv: s.iv, encrypted_content_tag: s.tag, encrypted_content_kid: s.kid };
    const { rows } = sanitiseTable(prompts, [src], ctx());
    const { encrypted_content, encrypted_content_iv, encrypted_content_tag, encrypted_content_kid, ...rest } = rows[0];
    expect(rest).toEqual({ id: UUID, creator_id: OTHER, title: "Sumer at dusk", tags: ["a", "b"], ai_settings: { steps: 20 }, price_usd_cents: 500 });
    expect(encrypted_content).not.toBe(s.ct);
    expect(openEnvelope({ ct: String(encrypted_content), iv: String(encrypted_content_iv), tag: String(encrypted_content_tag), kid: String(encrypted_content_kid) }, [{ kid: "field-v1", key: DEV_KEY }])).toBe("the secret prompt body");
  });

  it("lib/crypto opens what the sanitiser sealed (same wire format)", async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = DEV_KEY.toString("base64");
    const mod = await import("@/lib/crypto");
    mod.resetKeyringCache();
    const s = sealEnvelope("hello", DEV_KEY);
    expect(mod.decryptString({ encrypted: s.ct, iv: s.iv, authTag: s.tag, kid: s.kid })).toBe("hello");
    mod.resetKeyringCache();
  });

  it("assembles the production key ring like lib/crypto: current, retired by kid, legacy prompt key", () => {
    const b64 = () => randomBytes(32).toString("base64");
    const [cur, r1, legacy] = [b64(), b64(), b64()];
    const ring = keyringFromEnv({ FIELD_ENCRYPTION_KEY_B64: cur, FIELD_ENCRYPTION_KEYS_RETIRED: `field-v0:${r1}, :junk,broken`, PROMPT_ENCRYPTION_KEY: legacy });
    expect(ring.map((k) => k.kid)).toEqual(["field-v1", "field-v0", "prompt-legacy"]);
    expect(ring[1].key.equals(Buffer.from(r1, "base64"))).toBe(true);
    expect(() => keyringFromEnv({})).toThrow(/FIELD_ENCRYPTION_KEY_B64 is missing/);
    expect(() => keyringFromEnv({ FIELD_ENCRYPTION_KEY_B64: "short" })).toThrow(/32 bytes/);
  });
});

describe("emails", () => {
  const users = table("users", ["id", "handle", "email_ct", "email_iv", "email_tag", "email_kid", "email_lookup_hash"]);
  const creds = table("password_credentials", [["user_id", "uuid", "pk"], "email", "pw_hash", "pw_salt"]);
  const identities = table("auth_identities", ["provider", "subject", "user_id", "email", ["email_verified", "boolean"]]);

  it("the same user gets the same pseudonym in users, password_credentials and auth_identities", () => {
    const real = sealedWith(KEY_A, "kev@real-domain.example");
    const u = sanitiseTable(users, [{ id: UUID, handle: "kev", email_ct: real.ct, email_iv: real.iv, email_tag: real.tag, email_kid: real.kid, email_lookup_hash: emailLookupHash("kev@real-domain.example") }], ctx());
    const c = sanitiseTable(creds, [{ user_id: UUID, email: "kev@real-domain.example", pw_hash: "x", pw_salt: "y" }], ctx());
    const a = sanitiseTable(identities, [{ provider: "google", subject: "1", user_id: UUID, email: "kev@real-domain.example", email_verified: true }], ctx());
    const alias = `user-${UUID.slice(0, 8)}@example.test`;
    expect(c.rows[0].email).toBe(alias);
    expect(a.rows[0].email).toBe(alias);
    expect(a.rows[0].email_verified).toBe(true);
    const opened = openEnvelope({ ct: String(u.rows[0].email_ct), iv: String(u.rows[0].email_iv), tag: String(u.rows[0].email_tag), kid: String(u.rows[0].email_kid) }, [{ kid: "field-v1", key: DEV_KEY }]);
    expect(opened).toBe(alias);
    expect(u.rows[0].email_lookup_hash).toBe(emailLookupHash(alias));
    expect(u.rows[0].email_lookup_hash).not.toBe(emailLookupHash("kev@real-domain.example"));
    expect([u, c, a].map((r) => r.stats.pseudonyms)).toEqual([1, 1, 1]);
  });

  it("the lookup hash is what the feedback route computes: sha256 of the lowercased address", () => {
    const expected = createHash("sha256").update("User-Abc@Example.test".toLowerCase()).digest("hex");
    expect(emailLookupHash("User-Abc@Example.test")).toBe(expected);
    expect(emailLookupHash("user-abc@example.test")).toBe(expected);
  });

  it("an email envelope that production cannot open still becomes the pseudonym", () => {
    const stranger = sealedWith({ kid: "field-v1", key: randomBytes(32) }, "someone@real.example");
    const { rows, stats } = sanitiseTable(users, [{ id: UUID, handle: "x", email_ct: stranger.ct, email_iv: stranger.iv, email_tag: stranger.tag, email_kid: "field-v1", email_lookup_hash: "deadbeef" }], ctx());
    expect(openEnvelope({ ct: String(rows[0].email_ct), iv: String(rows[0].email_iv), tag: String(rows[0].email_tag) }, [{ kid: "field-v1", key: DEV_KEY }])).toBe(`user-${UUID.slice(0, 8)}@example.test`);
    expect(stats.decryptFailures).toBe(0);
  });

  it("guardian and admin envelopes are bound to the user id, as their readers expect", () => {
    const guardians = table("recovery_guardians", ["id", "user_id", "guardian_type", "guardian_value_ct", "guardian_value_iv", "guardian_value_tag", "guardian_value_kid", "guardian_value_lookup_hash", "guardian_user_id", "value", "invite_token"]);
    const s = sealedWith(KEY_A, "aunt@real.example", OTHER);
    const { rows } = sanitiseTable(guardians, [{ id: UUID, user_id: OTHER, guardian_type: "email", guardian_value_ct: s.ct, guardian_value_iv: s.iv, guardian_value_tag: s.tag, guardian_value_kid: s.kid, guardian_value_lookup_hash: "h", guardian_user_id: null, value: "aunt@real.example", invite_token: "tok" }], ctx());
    const alias = `user-${UUID.slice(0, 8)}@example.test`;
    const p = { ct: String(rows[0].guardian_value_ct), iv: String(rows[0].guardian_value_iv), tag: String(rows[0].guardian_value_tag) };
    expect(openEnvelope(p, [{ kid: "field-v1", key: DEV_KEY }], OTHER)).toBe(alias);
    expect(() => openEnvelope(p, [{ kid: "field-v1", key: DEV_KEY }])).toThrow();
    expect(rows[0].value).toBe(alias);
    expect(rows[0].guardian_value_lookup_hash).toBe(emailLookupHash(alias));
    expect(rows[0].invite_token).toBeNull();
  });

  it("a boolean column named email is not an address (notification_preferences.email)", () => {
    const prefs = table("notification_preferences", [["user_id", "uuid", "pk"], ["kind", "text", "pk"], ["in_app", "boolean"], ["email", "boolean"], ["push", "boolean"]]);
    const { rows, stats } = sanitiseTable(prefs, [{ user_id: UUID, kind: "follow", in_app: true, email: false, push: true }], ctx());
    expect(rows[0].email).toBe(false);
    expect(stats.pseudonyms).toBe(0);
  });

  it("pseudonym falls back from user_id to id and uses the guardian's own id for guardians", () => {
    expect(pseudonym({ id: UUID }, "access_requests")).toBe(`user-${UUID.slice(0, 8)}@example.test`);
    expect(pseudonym({ id: UUID, user_id: OTHER }, "feedback_submissions")).toBe(`user-${OTHER.slice(0, 8)}@example.test`);
    expect(pseudonym({ id: UUID, user_id: OTHER, guardian_user_id: "abcdefgh-rest" }, "recovery_guardians")).toBe("user-abcdefgh@example.test");
    expect(pseudonym({ id: UUID, user_id: OTHER, guardian_user_id: null }, "recovery_guardians")).toBe(`user-${UUID.slice(0, 8)}@example.test`);
  });
});

describe("passwords", () => {
  const creds = table("password_credentials", [["user_id", "uuid", "pk"], "email", "pw_hash", "pw_salt"]);
  const before = process.env.AUTH_PEPPER;
  beforeEach(() => { process.env.AUTH_PEPPER = DEV_PEPPER; });
  afterEach(() => { if (before === undefined) delete process.env.AUTH_PEPPER; else process.env.AUTH_PEPPER = before; });

  it("every copied credential verifies with lib/password-auth for the dev password under the dev pepper", { timeout: 30_000 }, async () => {
    const { verifyPassword } = await import("@/lib/password-auth");
    const c = ctx();
    const { rows } = sanitiseTable(creds, [
      { user_id: UUID, email: "a@real.example", pw_hash: "prod-hash", pw_salt: "prod-salt" },
      { user_id: OTHER, email: "b@real.example", pw_hash: "prod-hash-2", pw_salt: "prod-salt-2" },
    ], c);
    for (const r of rows) {
      expect(r.pw_hash).not.toBe("prod-hash");
      expect(verifyPassword(DEV_PASSWORD, String(r.pw_hash), String(r.pw_salt))).toBe(true);
      expect(verifyPassword("not-the-dev-password", String(r.pw_hash), String(r.pw_salt))).toBe(false);
    }
    expect(c.devCredential).toBeDefined();
  });

  it("a different pepper does not verify: the credential is bound to the dev environment", { timeout: 30_000 }, async () => {
    const { verifyPassword } = await import("@/lib/password-auth");
    const { rows } = sanitiseTable(creds, [{ user_id: UUID, email: "a@real.example", pw_hash: "h", pw_salt: "s" }], ctx());
    process.env.AUTH_PEPPER = randomBytes(32).toString("base64");
    expect(verifyPassword(DEV_PASSWORD, String(rows[0].pw_hash), String(rows[0].pw_salt))).toBe(false);
  });
});

describe("tokens, ip hashes, emptied tables", () => {
  it("nulls token and ip hash columns, hashes a redacted primary key instead of nulling it", () => {
    const nonces = table("auth_nonces_like", ["id", "user_id", "session_token_hash", "issued_to_ip_hash", "issued_to_ua_hash", "revoke_reason"]);
    const { rows } = sanitiseTable(nonces, [{ id: UUID, user_id: OTHER, session_token_hash: "t", issued_to_ip_hash: "i", issued_to_ua_hash: "u", revoke_reason: "r" }], ctx());
    expect(rows[0]).toMatchObject({ session_token_hash: null, issued_to_ip_hash: null, issued_to_ua_hash: "u", revoke_reason: "r" });

    const bans = table("ip_bans", [["ip_hash", "text", "pk"], "reason", "issued_by"]);
    const b = sanitiseTable(bans, [{ ip_hash: "prod-hmac", reason: "spam", issued_by: OTHER }], ctx());
    expect(b.rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.rows[0].ip_hash).not.toBe("prod-hmac");
    expect(b.rows[0].reason).toBe("spam");
  });

  it("matches token columns by name shape, not by substring", () => {
    const wl = table("friends_whitelist", ["id", "token_standard", ["qualifying_token_ids", "text[]"], "approve_token", "invite_token", "token"]);
    const { rows } = sanitiseTable(wl, [{ id: UUID, token_standard: "erc721", qualifying_token_ids: ["1"], approve_token: "a", invite_token: "b", token: "c" }], ctx());
    expect(rows[0]).toMatchObject({ token_standard: "erc721", qualifying_token_ids: ["1"], approve_token: null, invite_token: null, token: null });
    const events = table("automod_events", ["id", "ip_hash", "prompt_hash", "user_id"]);
    expect(sanitiseTable(events, [{ id: UUID, ip_hash: "x", prompt_hash: "keep", user_id: OTHER }], ctx()).rows[0]).toMatchObject({ ip_hash: null, prompt_hash: "keep" });
    const proposals = table("mod_proposals", ["id", "target_ip_hash", "kind"]);
    expect(sanitiseTable(proposals, [{ id: UUID, target_ip_hash: "x", kind: "ban" }], ctx()).rows[0].target_ip_hash).toBeNull();
    const requests = table("recovery_requests", ["id", "request_ip_hash", "status"]);
    expect(sanitiseTable(requests, [{ id: UUID, request_ip_hash: "x", status: "open" }], ctx()).rows[0].request_ip_hash).toBeNull();
  });

  it("drops the last_seen_ip envelope of user_authenticators", () => {
    const auths = table("user_authenticators", ["id", "user_id", "last_seen_ip_ct", "last_seen_ip_iv", "last_seen_ip_tag", "last_seen_ip_kid", "device_label"]);
    const s = sealedWith(KEY_A, "203.0.113.9", OTHER);
    const { rows, stats } = sanitiseTable(auths, [{ id: UUID, user_id: OTHER, last_seen_ip_ct: s.ct, last_seen_ip_iv: s.iv, last_seen_ip_tag: s.tag, last_seen_ip_kid: s.kid, device_label: "phone" }], ctx());
    expect(rows[0]).toMatchObject({ last_seen_ip_ct: null, last_seen_ip_iv: null, last_seen_ip_tag: null, last_seen_ip_kid: null, device_label: "phone" });
    expect(stats.rekeyed).toBe(0);
  });

  it("emptied tables export no rows and say so", () => {
    expect([...EMPTIED_TABLES].sort()).toEqual(["auth_nonces", "auth_sessions", "delete_confirm_tokens", "deletion_approvals", "otp_sessions", "password_reset_tokens", "user_sessions"]);
    for (const name of EMPTIED_TABLES) {
      const { rows, stats } = sanitiseTable(table(name, ["id", "token"]), [{ id: UUID, token: "live" }], ctx());
      expect(rows).toEqual([]);
      expect(stats).toMatchObject({ table: name, rows: 0, emptied: true });
    }
    expect(sanitiseTable(table("models", ["id", "name"]), [{ id: UUID, name: "nano" }], ctx()).stats.emptied).toBe(false);
  });
});

describe("discovery and patch plan", () => {
  it("reads tables, formats and primary keys from the PostgREST OpenAPI document", () => {
    const spec = { definitions: {
      users: { properties: { id: { type: "string", format: "uuid", description: "Note:\nThis is a Primary Key.<pk/>" }, tags: { type: "array", format: "text[]" }, bio: { type: "string" } } },
      admin_roles: { properties: { user_id: { format: "uuid", description: "<pk/>" }, role: { format: "text", description: "<pk/>" } } },
    } };
    expect(parseOpenApi(spec)).toEqual([
      { name: "admin_roles", columns: [{ name: "user_id", format: "uuid", pk: true }, { name: "role", format: "text", pk: true }] },
      { name: "users", columns: [{ name: "id", format: "uuid", pk: true }, { name: "tags", format: "text[]", pk: false }, { name: "bio", format: "string", pk: false }] },
    ]);
  });

  it("groups information_schema rows into tables, in column order, sorted by name", () => {
    const tables = tablesFromColumns([
      { table_name: "users", column_name: "id", udt_name: "uuid", pk: true },
      { table_name: "users", column_name: "handle", udt_name: "citext", pk: false },
      { table_name: "admin_roles", column_name: "user_id", udt_name: "uuid", pk: true },
    ]);
    expect(tables).toEqual([
      { name: "admin_roles", columns: [{ name: "user_id", format: "uuid", pk: true }] },
      { name: "users", columns: [{ name: "id", format: "uuid", pk: true }, { name: "handle", format: "citext", pk: false }] },
    ]);
  });

  it("knows which tables a rule can touch, so the others are never read", () => {
    expect(tableNeedsSanitising(table("models", ["id", "name", ["active", "boolean"]]))).toBe(false);
    expect(tableNeedsSanitising(table("generations", ["id", "final_prompt_ct", "final_prompt_iv", "final_prompt_tag"]))).toBe(true);
    expect(tableNeedsSanitising(table("access_requests", ["id", "email", "about"]))).toBe(true);
    expect(tableNeedsSanitising(table("automod_events", ["id", "ip_hash"]))).toBe(true);
    expect(tableNeedsSanitising(table("recovery_guardians", ["id", "value"]))).toBe(true);
    expect(tableNeedsSanitising(table("password_credentials", [["user_id", "uuid", "pk"], "pw_hash"]))).toBe(true);
    expect(tableNeedsSanitising(table("auth_sessions", ["id"]))).toBe(true);
    expect(tableNeedsSanitising(table("friends_whitelist", ["id", "token_standard"]))).toBe(false);
  });

  it("paginates in pages of 1000 until a short page", async () => {
    const calls: [number, number][] = [];
    const all = Array.from({ length: 2500 }, (_, i) => i);
    const rows = await paginate(async (from, to) => { calls.push([from, to]); return all.slice(from, to + 1); });
    expect(rows).toEqual(all);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(await paginate(async () => [], 1000)).toEqual([]);
  });

  it("a patch carries only the changed columns, addressed by the primary key as it was before", () => {
    const users = table("users", ["id", "handle", "email_lookup_hash", ["tags", "text[]"]]);
    const before: Row = { id: UUID, handle: "kev", email_lookup_hash: "old", tags: ["a"] };
    expect(rowPatch(users, before, { ...before, email_lookup_hash: "new" })).toEqual({ filter: { id: UUID }, body: { email_lookup_hash: "new" } });
    expect(rowPatch(users, before, { ...before, tags: ["a"] })).toBeNull();
    const composite = table("auth_identities", [["provider", "text", "pk"], ["subject", "text", "pk"], "email"]);
    expect(rowPatch(composite, { provider: "google", subject: "1", email: "a" }, { provider: "google", subject: "1", email: "b" })).toEqual({ filter: { provider: "google", subject: "1" }, body: { email: "b" } });
    const bans = table("ip_bans", [["ip_hash", "text", "pk"], "reason"]);
    expect(rowPatch(bans, { ip_hash: "old", reason: "r" }, { ip_hash: "hashed", reason: "r" })).toEqual({ filter: { ip_hash: "old" }, body: { ip_hash: "hashed" } });
    const noPk = table("orphan", [["a", "text"], ["b", "text"]]);
    expect(() => rowPatch(noPk, { a: "1", b: "x" }, { a: "1", b: "y" })).toThrow(/no primary key/);
  });
});
