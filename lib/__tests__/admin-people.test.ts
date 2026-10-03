import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The admin person list (Kev, 2026-10-03): one row per person with what
 * enforcement counts, and every event with its prompt and settings on
 * expanding, so whoever is failing on what can be fixed fast. Someone without
 * an account is a person too, by hashed address. A child-safety case is an
 * admin's call, its ban included.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
/** Tables whose reads fail as an unreachable database would. */
let failing = new Set<string>();
const WEEK = 7 * 86400_000;

/** The view moderation_people, as migrations/2026-10-03-generation-failures.sql defines it. */
function moderationPeople(): Row[] {
  const now = new Date().toISOString();
  const reasons = [
    ...tables.automod_events.filter((r) => r.decision === "block" && (r.user_id || r.ip_hash))
      .map((r) => ({ user_id: r.user_id ?? null, ip_hash: r.user_id ? null : r.ip_hash, at: r.created_at, open: r.review_state === "pending" })),
    ...tables.generation_failures.filter((r) => String(r.created_at) > new Date(Date.now() - WEEK).toISOString() && (r.user_id || r.ip_hash))
      .map((r) => ({ user_id: r.user_id ?? null, ip_hash: r.user_id ? null : r.ip_hash, at: r.created_at, open: false })),
    ...tables.bans.filter((b) => !b.lifted_at && (!b.expires_at || String(b.expires_at) > now))
      .map((b) => ({ user_id: b.user_id, ip_hash: null, at: b.created_at, open: false })),
  ];
  const groups = new Map<string, Row>();
  for (const r of reasons) {
    const k = `${r.user_id}|${r.ip_hash}`;
    const g = groups.get(k) ?? { user_id: r.user_id, ip_hash: r.ip_hash, last_at: r.at, pending: false };
    if (String(r.at) > String(g.last_at)) g.last_at = r.at;
    g.pending = g.pending || r.open;
    groups.set(k, g);
  }
  return [...groups.values()];
}

class Query implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private filters: ((r: Row) => boolean)[] = [];
  private sorts: [string, boolean][] = [];
  private cap = Infinity;
  private countOnly = false;
  private one = false;
  private patch: Row | null = null;
  constructor(private table: string) {}
  select(_c?: string, o?: { head?: boolean }) { if (o?.head) this.countOnly = true; return this; }
  update(p: Row) { this.patch = p; return this; }
  private added: Row | null = null;
  insert(p: Row) { this.added = p; return this; }
  single() { this.one = true; return this; }
  filter(c: string, op: string, v: unknown) { return op === "is" ? this.is(c, v as null) : this.eq(c, v); }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: null) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  gte(c: string, v: string) { this.filters.push((r) => String(r[c]) >= v); return this; }
  or(expr: string) {
    // Only the active-ban shape is used: "expires_at.is.null,expires_at.gt.<iso>".
    const iso = expr.split("expires_at.gt.")[1];
    this.filters.push((r) => r.expires_at == null || String(r.expires_at) > iso);
    return this;
  }
  order(c: string, o: { ascending: boolean }) { this.sorts.push([c, o.ascending]); return this; }
  limit(n: number) { this.cap = n; return this; }
  maybeSingle() { this.one = true; return this; }
  then<A, B = never>(ok?: ((v: { data: unknown; error: null; count?: number }) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    if (failing.has(this.table)) {
      return Promise.resolve({ data: null, error: { message: "TypeError: fetch failed" } as unknown as null, count: undefined }).then(ok, ko);
    }
    const source = this.table === "moderation_people" ? moderationPeople() : (tables[this.table] ??= []);
    let rows = source.filter((r) => this.filters.every((f) => f(r)));
    if (this.added) {
      const row = { id: `${this.table}-${(tables[this.table] ??= []).length + 1}`, created_at: new Date().toISOString(), ...this.added };
      tables[this.table].push(row);
      return Promise.resolve({ data: this.one ? { id: row.id } : [row], error: null }).then(ok, ko);
    }
    if (this.patch) { rows.forEach((r) => Object.assign(r, this.patch)); return Promise.resolve({ data: null, error: null }).then(ok, ko); }
    for (const [c, asc] of [...this.sorts].reverse()) {
      rows = [...rows].sort((a, b) => (asc ? 1 : -1) * (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0));
    }
    rows = rows.slice(0, this.cap);
    const res = this.countOnly ? { data: null, error: null as null, count: rows.length } : { data: this.one ? rows[0] ?? null : rows, error: null as null };
    return Promise.resolve(res).then(ok, ko);
  }
}
const fake = { from: (t: string) => new Query(t) } as unknown as SupabaseClient;

vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => fake }));
vi.mock("@/lib/session-user", async (original) => ({
  ...(await original<typeof import("@/lib/session-user")>()),
  resolveSessionUserId: async (_s: unknown, t: string | null) => ({ "mod-tok": "mod-1", "admin-tok": "admin-1", "owner-tok": "owner-1" } as Record<string, string>)[t ?? ""] ?? null,
}));
const notified = vi.fn(async (_s: unknown, _m: { subject: string; text: string }) => {});
vi.mock("@/lib/admin-notify", () => ({ notifyAdmins: (s: unknown, m: { subject: string; text: string }) => notified(s, m) }));

import { listPeople, personDetail, parsePersonKey, hasChildSafetyCase } from "@/lib/admin/people";
import { GET, POST } from "../../app/api/admin/route";
import { randomBytes } from "node:crypto";
import { decryptString, encryptString, resetKeyringCache } from "@/lib/crypto";
import { sealEvidence } from "@/lib/moderation/evidence";

const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
const ev = (user: string | null, category: string, extra: Row = {}): Row => ({
  id: `e${Math.random()}`, user_id: user, ip_hash: null, decision: "block", category, review_state: "none",
  scores: { weight: category === "minor_sexual" ? 10 : 1 }, created_at: ago(1), ...extra,
});

beforeEach(() => {
  process.env.FIELD_ENCRYPTION_KEY_B64 = randomBytes(32).toString("base64");
  resetKeyringCache();
  failing = new Set();
  tables = {
    automod_events: [], generation_failures: [], bans: [], appeals: [], models: [{ id: "m1", name: "GPT Image 2" }],
    users: [
      { id: "u1", handle: "anna", display_name: "Anna" }, { id: "u2", handle: "ben", display_name: null },
      { id: "mod-1", role: "mod" }, { id: "admin-1", role: "admin" }, { id: "owner-1", role: "admin", handle: "owner" },
    ],
  };
  notified.mockClear();
});

describe("revealing an artist's withheld text", () => {
  beforeEach(() => {
    tables.moderation_policy = [{ id: 1, owner_user_id: "owner-1" }];
    tables.artist_text_reveals = [];
  });
  const SECRET = "the artist's secret words around [subject]";
  const post = (token: string, body: unknown) => POST(new NextRequest("http://enki.test/api/admin", {
    method: "POST", headers: { "X-Session-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  const record = (e: Parameters<typeof sealEvidence>[0], surface = "upload") => {
    const s = sealEvidence(e)!;
    const row = ev("u1", "explicit_sexual", { id: "e-1", surface, evidence_ct: s.encrypted, evidence_iv: s.iv, evidence_tag: s.authTag, evidence_kid: s.kid });
    tables.automod_events.push(row);
    return row;
  };
  const WHY = "Appeal of a child-safety case on this save";

  it("shows the moderation owner the withheld text and logs who, which and why first", async () => {
    record({ shown: "{}", withheld: SECRET });
    const res = await post("owner-tok", { resource: "automod", action: "reveal", id: "e-1", reason: WHY });
    expect(await res.json()).toEqual({ text: SECRET, source: "record" });
    expect(tables.artist_text_reveals).toEqual([expect.objectContaining({ event_id: "e-1", revealed_by: "owner-1", reason: WHY, prompt_id: null })]);
    // Every admin is told, without the text.
    expect(notified).toHaveBeenCalledOnce();
    expect(JSON.stringify(notified.mock.calls[0][1])).toContain(WHY);
    expect(JSON.stringify(notified.mock.calls[0][1])).not.toContain("secret words");
  });

  it("shows a named marketplace prompt's text as it stands now", async () => {
    record({ shown: '{"subject":"fox"}', promptId: "p1" }, "generate-image");
    tables.prompts = [{ id: "p1", public_prompt_text: "a free [subject]", price_usd_cents: 0, prompt_type: "free", is_adult: false }];
    tables.prompt_variables = [];
    const res = await post("owner-tok", { resource: "automod", action: "reveal", id: "e-1", reason: WHY });
    expect(await res.json()).toEqual({ text: "a free [subject]", source: "prompt" });
    expect(tables.artist_text_reveals[0]).toMatchObject({ prompt_id: "p1" });
  });

  it("shows nothing to an admin who is not the owner, nor to a mod", async () => {
    record({ shown: "{}", withheld: SECRET });
    for (const tok of ["admin-tok", "mod-tok"]) {
      const res = await post(tok, { resource: "automod", action: "reveal", id: "e-1", reason: WHY });
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain("secret words");
    }
    expect(tables.artist_text_reveals).toEqual([]);
  });

  it("shows nothing to an owner who is no longer an admin", async () => {
    record({ shown: "{}", withheld: SECRET });
    tables.users.find((u) => u.id === "owner-1")!.role = "mod";
    expect((await post("owner-tok", { resource: "automod", action: "reveal", id: "e-1", reason: WHY })).status).toBe(403);
    expect(tables.artist_text_reveals).toEqual([]);
  });

  it("is offered in the panel to the owner alone", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const page = readFileSync(join(__dirname, "..", "..", "app", "admin", "page.tsx"), "utf8");
    expect(page).toContain("{data?.council.isOwner && !revealed[id] && (");
    expect(page).toContain('body: JSON.stringify({ resource: "automod", action: "reveal", id, reason }),');
    expect(page.match(/withheldBlock\((e|r)\.id\)/g)).toHaveLength(2);
  });

  it("asks for a reason", async () => {
    record({ shown: "{}", withheld: SECRET });
    for (const reason of [undefined, "", "because"]) {
      expect((await post("owner-tok", { resource: "automod", action: "reveal", id: "e-1", reason })).status).toBe(400);
    }
    expect(tables.artist_text_reveals).toEqual([]);
  });

  it("shows nothing when the reveal cannot be logged", async () => {
    record({ shown: "{}", withheld: SECRET });
    failing.add("artist_text_reveals");
    const res = await post("owner-tok", { resource: "automod", action: "reveal", id: "e-1", reason: WHY });
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("secret words");
    expect(notified).not.toHaveBeenCalled();
  });

  it("logs nothing for a record that withholds nothing", async () => {
    record({ shown: "a user's own words" }, "generate-free");
    expect((await post("owner-tok", { resource: "automod", action: "reveal", id: "e-1", reason: WHY })).status).toBe(404);
    expect(tables.artist_text_reveals).toEqual([]);
  });
});

describe("the person list", () => {
  it("counts warnings the way enforcement does", async () => {
    tables.automod_events.push(ev("u1", "explicit_sexual"), ev("u1", "explicit_sexual"), ev("u1", "explicit_sexual", { review_state: "overturned" }));
    const [anna] = await listPeople(fake);
    expect(anna).toMatchObject({ key: "u1", userId: "u1", handle: "anna", warnings: 2 });
  });

  it("flags a child-safety case that was not overturned", async () => {
    tables.automod_events.push(ev("u1", "minor_sexual", { review_state: "pending" }), ev("u1", "explicit_sexual"));
    const [anna] = await listPeople(fake);
    expect(anna).toMatchObject({ childSafety: true, pending: 1, warnings: 11 });
  });

  it("drops the flag once the case is overturned", async () => {
    tables.automod_events.push(ev("u1", "minor_sexual", { review_state: "overturned" }));
    expect((await listPeople(fake))[0].childSafety).toBe(false);
  });

  it("counts extraction hits of the last 30 days only, overturned ones out", async () => {
    tables.automod_events.push(ev("u1", "extraction"), ev("u1", "extraction", { created_at: ago(40) }), ev("u1", "extraction", { review_state: "overturned" }));
    expect((await listPeople(fake))[0].extractionHits).toBe(1);
  });

  it("shows a running suspension and leaves an expired one out", async () => {
    const until = ago(-3);
    tables.bans.push({ user_id: "u1", lifted_at: null, expires_at: until, created_at: ago(1) });
    tables.bans.push({ user_id: "u2", lifted_at: null, expires_at: ago(1), created_at: ago(5) });
    tables.automod_events.push(ev("u2", "explicit_sexual"));
    const people = await listPeople(fake);
    expect(people.find((p) => p.userId === "u1")?.suspension).toEqual({ until });
    expect(people.find((p) => p.userId === "u2")?.suspension).toBeNull();
  });

  it("lists a person whose generations failed this week, with the count", async () => {
    tables.generation_failures.push({ user_id: "u2", created_at: ago(2) }, { user_id: "u2", created_at: ago(3) }, { user_id: "u2", created_at: ago(9) });
    const [ben] = await listPeople(fake);
    expect(ben).toMatchObject({ userId: "u2", failed7d: 2 });
  });

  it("puts open cases first, then the most recently active", async () => {
    tables.automod_events.push(
      ev("u1", "explicit_sexual", { created_at: ago(1) }),
      ev("u2", "minor_sexual", { created_at: ago(20), review_state: "pending" }),
    );
    expect((await listPeople(fake)).map((p) => p.key)).toEqual(["u2", "u1"]);
  });

  it("orders by recency when nothing is open", async () => {
    tables.automod_events.push(ev("u1", "explicit_sexual", { created_at: ago(5) }), ev("u2", "explicit_sexual", { created_at: ago(1) }));
    expect((await listPeople(fake)).map((p) => p.key)).toEqual(["u2", "u1"]);
  });

  it("is not taken over by one busy account", async () => {
    for (let i = 0; i < 1500; i++) tables.automod_events.push(ev("u1", "violence", { created_at: ago(0) }));
    tables.automod_events.push(ev("u2", "explicit_sexual", { created_at: ago(3) }));
    expect((await listPeople(fake)).map((p) => p.key)).toEqual(["u1", "u2"]);
  });

  it("lists someone without an account by hashed address, apart from accounts on it", async () => {
    tables.automod_events.push(
      ev(null, "minor_sexual", { ip_hash: HASH, review_state: "pending" }),
      ev("u1", "explicit_sexual", { ip_hash: HASH }),
    );
    tables.generation_failures.push({ user_id: null, ip_hash: HASH, created_at: ago(1) });
    const anon = (await listPeople(fake)).find((p) => p.key === `ip:${HASH}`);
    expect(anon).toMatchObject({ userId: null, ipHash: HASH, warnings: 10, childSafety: true, pending: 1, failed7d: 1, suspension: null });
  });

  it("is empty when nobody needs looking at", async () => {
    expect(await listPeople(fake)).toEqual([]);
  });
});

describe("a person key", () => {
  it("is an account id or a hashed address, nothing else", () => {
    expect(parsePersonKey("0b5f2c1e-1111-4222-8333-444455556666")).toEqual({ userId: "0b5f2c1e-1111-4222-8333-444455556666" });
    expect(parsePersonKey(`ip:${HASH}`)).toEqual({ ipHash: HASH });
    for (const bad of ["u1", "ip:", "ip:xyz", `ip:${HASH}'`, "1;drop"]) expect(parsePersonKey(bad)).toBeNull();
  });
});

describe("one person, expanded", () => {
  const decrypt = (ct: unknown) => (ct === "secret" ? "the decrypted prompt" : null);

  it("shows every event with its prompt, weight and state", async () => {
    const sealed = sealEvidence({ shown: "the decrypted prompt" })!;
    tables.automod_events.push(ev("u1", "explicit_sexual", {
      evidence_ct: sealed.encrypted, evidence_iv: sealed.iv, evidence_tag: sealed.authTag, evidence_kid: sealed.kid,
      surface: "generate-image", severity: "strike", tier: 2, scores: { weight: 1, confidence: 0.92 },
    }));
    const d = await personDetail(fake, { userId: "u1" }, decrypt);
    expect(d.events[0]).toMatchObject({ category: "explicit_sexual", prompt: "the decrypted prompt", withheld: false, weight: 1, confidence: 0.92, state: "none" });
  });

  it("never shows the artist text a refused save withheld", async () => {
    const sealed = sealEvidence({ shown: "{\"title\":\"Moody\"}", withheld: "the artist's secret words" })!;
    tables.automod_events.push(ev("u1", "explicit_sexual", {
      evidence_ct: sealed.encrypted, evidence_iv: sealed.iv, evidence_tag: sealed.authTag, evidence_kid: sealed.kid, surface: "upload",
    }));
    // A save recorded before the rule, its body inside, read with the real key.
    const legacy = encryptString("Moody\nthe artist's secret words");
    tables.automod_events.push(ev("u1", "explicit_sexual", {
      evidence_ct: legacy.encrypted, evidence_iv: legacy.iv, evidence_tag: legacy.authTag, evidence_kid: legacy.kid, surface: "upload",
    }));
    const real = (ct: unknown, iv: unknown, tag: unknown, kid: unknown) => {
      try { return decryptString({ encrypted: String(ct), iv: String(iv), authTag: String(tag), kid: kid ? String(kid) : undefined }); } catch { return null; }
    };
    const d = await personDetail(fake, { userId: "u1" }, real);
    expect(d.events.find((e) => e.prompt !== null)).toMatchObject({ prompt: "{\"title\":\"Moody\"}", withheld: true });
    expect(d.events.filter((e) => e.withheld)).toHaveLength(2);
    expect(JSON.stringify(d)).not.toContain("secret words");
  });

  it("shows a failure with its settings, error and model name", async () => {
    tables.generation_failures.push({
      id: "f1", user_id: "u1", surface: "generate-image", model_id: "m1", resolution: "2K", quality: "high", boost: false,
      aspect_ratio: "16:9", reference_image_count: 2, error: "provider said no", prompt_ct: "secret", created_at: ago(1),
    });
    const d = await personDetail(fake, { userId: "u1" }, decrypt);
    expect(d.failures[0]).toMatchObject({
      model: "GPT Image 2", resolution: "2K", quality: "high", aspectRatio: "16:9", referenceImageCount: 2, error: "provider said no", prompt: "the decrypted prompt", draft: false,
    });
  });

  it("says a failure without text was an artist's draft", async () => {
    tables.generation_failures.push({ id: "f2", user_id: "u1", surface: "generate-free", error: "provider said no", created_at: ago(1) });
    expect((await personDetail(fake, { userId: "u1" }, decrypt)).failures[0]).toMatchObject({ prompt: null, draft: true });
  });

  it("shows only that person's events", async () => {
    tables.automod_events.push(ev("u2", "explicit_sexual"));
    expect((await personDetail(fake, { userId: "u1" }, decrypt)).events).toEqual([]);
  });

  it("shows an address's own events, not those of accounts on it", async () => {
    tables.automod_events.push(ev(null, "minor_sexual", { ip_hash: HASH }), ev("u1", "explicit_sexual", { ip_hash: HASH }));
    const d = await personDetail(fake, { ipHash: HASH }, decrypt);
    expect(d.events.map((e) => e.category)).toEqual(["minor_sexual"]);
    expect(d.bans).toEqual([]);
  });
});

describe("a child-safety case", () => {
  it("is open until overturned", async () => {
    tables.automod_events.push(ev("u1", "sexual/minors", { review_state: "upheld" }));
    expect(await hasChildSafetyCase(fake, "u1")).toBe(true);
    tables.automod_events[0].review_state = "overturned";
    expect(await hasChildSafetyCase(fake, "u1")).toBe(false);
  });
});

describe("the admin route", () => {
  const post = (token: string, body: unknown) => POST(new NextRequest("http://enki.test/api/admin", {
    method: "POST", headers: { "X-Session-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  const banU1 = () => tables.bans.push({ id: "b1", user_id: "u1", lifted_at: null, expires_at: null, created_at: ago(1) });

  it("lets a mod lift an ordinary suspension", async () => {
    banU1();
    tables.automod_events.push(ev("u1", "explicit_sexual"));
    expect((await post("mod-tok", { resource: "bans", action: "lift", userId: "u1" })).status).toBe(200);
    expect(tables.bans[0].lifted_at).toBeTruthy();
  });

  it("does not let a mod lift a ban after a child-safety case", async () => {
    banU1();
    tables.automod_events.push(ev("u1", "minor_sexual"));
    expect((await post("mod-tok", { resource: "bans", action: "lift", userId: "u1" })).status).toBe(403);
    expect(tables.bans[0].lifted_at).toBeNull();
  });

  it("lets an admin lift it", async () => {
    banU1();
    tables.automod_events.push(ev("u1", "minor_sexual"));
    expect((await post("admin-tok", { resource: "bans", action: "lift", userId: "u1" })).status).toBe(200);
  });

  it("does not let a mod approve the appeal against such a ban", async () => {
    banU1();
    tables.automod_events.push(ev("u1", "csam"));
    tables.appeals.push({ id: "a1", target_type: "ban", target_uuid: "b1", status: "pending" });
    expect((await post("mod-tok", { resource: "appeals", action: "approve", id: "a1" })).status).toBe(403);
    expect(tables.appeals[0].status).toBe("pending");
    expect(tables.bans[0].lifted_at).toBeNull();
  });

  it("does not let a mod overturn a child-safety case", async () => {
    tables.automod_events.push(ev("u1", "minor_sexual", { id: "e1" }));
    expect((await post("mod-tok", { resource: "automod", action: "overturn", id: "e1" })).status).toBe(403);
    expect(tables.automod_events[0].review_state).toBe("none");
  });

  it("lets a mod overturn an ordinary warning, without deleting it", async () => {
    tables.automod_events.push(ev("u1", "explicit_sexual", { id: "e1" }));
    expect((await post("mod-tok", { resource: "automod", action: "overturn", id: "e1" })).status).toBe(200);
    expect(tables.automod_events).toHaveLength(1);
    expect(tables.automod_events[0].review_state).toBe("overturned");
  });

  it("is closed to everyone else", async () => {
    expect((await post("nobody", { resource: "bans", action: "lift", userId: "u1" })).status).toBe(401);
  });
});

describe("a ban landing on a running one", () => {
  it("extends it to the later end, never shortens it", async () => {
    const { laterEnd } = await import("@/lib/moderation/bans");
    expect(laterEnd("2026-10-06T00:00:00Z", "2026-11-02T00:00:00Z")).toBe("2026-11-02T00:00:00Z");
    expect(laterEnd("2026-11-02T00:00:00Z", "2026-10-06T00:00:00Z")).toBe("2026-11-02T00:00:00Z");
    expect(laterEnd("2026-10-06T00:00:00Z", null)).toBeNull();
    expect(laterEnd(null, "2026-11-02T00:00:00Z")).toBeNull();
  });
});

describe("the admin route, more", () => {
  const post = (token: string, body: unknown) => POST(new NextRequest("http://enki.test/api/admin", {
    method: "POST", headers: { "X-Session-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));

  it("lands a 30-day ban beside a running 3-day suspension, each keeping its own row", async () => {
    const short = ago(-3);
    tables.bans.push({ id: "b1", user_id: "u1", lifted_at: null, expires_at: short, created_at: ago(0), reason: "ladder" });
    expect((await post("admin-tok", { resource: "bans", action: "ban", userId: "u1", days: 30 })).status).toBe(200);
    expect(tables.bans).toHaveLength(2);
    expect(tables.bans[0]).toMatchObject({ expires_at: short, reason: "ladder" });
    expect(String(tables.bans[1].expires_at) > ago(-29)).toBe(true);
  });

  it("says so when the same ban already lasts longer", async () => {
    const until = ago(-60);
    tables.bans.push({ id: "b1", user_id: "u1", lifted_at: null, expires_at: until, created_at: ago(0), reason: "Banned from the admin panel" });
    const res = await post("admin-tok", { resource: "bans", action: "ban", userId: "u1", days: 30 });
    expect(res.status).toBe(400);
    expect(tables.bans[0].expires_at).toBe(until);
  });

  it("lets a mod approve the appeal against an ordinary ban", async () => {
    tables.bans.push({ id: "b1", user_id: "u1", lifted_at: null, expires_at: null, created_at: ago(1) });
    tables.automod_events.push(ev("u1", "explicit_sexual"));
    tables.appeals.push({ id: "a1", target_type: "ban", target_uuid: "b1", status: "pending" });
    expect((await post("mod-tok", { resource: "appeals", action: "approve", id: "a1" })).status).toBe(200);
    expect(tables.appeals[0].status).toBe("approved");
    expect(tables.bans[0].lifted_at).toBeTruthy();
  });
});

describe("the council's ban", () => {
  it("goes through the same rule", async () => {
    const { readSource } = await import("@/lib/__tests__/_read-source");
    const { join } = await import("node:path");
    const SRC = readSource(join(__dirname, "..", "..", "app", "api", "admin", "route.ts"));
    expect(SRC).toMatch(/const issued = await banUntil\(supabase, \{\n\s+userId: String\(p\.target_user_id\), issuedBy: String\(p\.proposed_by\), reason, expiresAt: until,/);
    // A ban that could not be issued leaves the proposal unexecuted.
    expect(SRC).toMatch(/\}\)\.catch\(\(\) => null\);\n\s+if \(!issued\) return \{ message: "the ban could not be issued" \};/);
  });
});

describe("when the database fails", () => {
  const post = (token: string, body: unknown) => POST(new NextRequest("http://enki.test/api/admin", {
    method: "POST", headers: { "X-Session-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));

  it("the list still answers, without the suspension it could not read", async () => {
    tables.automod_events.push(ev("u1", "explicit_sexual"));
    failing.add("bans");
    expect((await listPeople(fake))[0]).toMatchObject({ key: "u1", warnings: 1, suspension: null });
  });

  it("a child-safety check that cannot read counts as a case", async () => {
    failing.add("automod_events");
    expect(await hasChildSafetyCase(fake, "u1")).toBe(true);
  });

  it("an appeal whose ban cannot be read is not approved", async () => {
    tables.appeals.push({ id: "a1", target_type: "ban", target_uuid: "b1", status: "pending" });
    failing.add("bans");
    expect((await post("mod-tok", { resource: "appeals", action: "approve", id: "a1" })).status).toBe(500);
    expect(tables.appeals[0].status).toBe("pending");
  });
});

describe("someone without an account", () => {
  it("is counted over the last 30 days, as enforcement counts them", async () => {
    tables.automod_events.push(
      ev(null, "explicit_sexual", { ip_hash: HASH, created_at: ago(40) }),
      ev(null, "explicit_sexual", { ip_hash: HASH, created_at: ago(2) }),
    );
    expect((await listPeople(fake)).find((p) => p.key === `ip:${HASH}`)?.warnings).toBe(1);
  });

  it("while an account keeps every warning it ever got", async () => {
    tables.automod_events.push(ev("u1", "explicit_sexual", { created_at: ago(40) }), ev("u1", "explicit_sexual", { created_at: ago(2) }));
    expect((await listPeople(fake))[0].warnings).toBe(2);
  });
});

describe("the strikes tab with several bans", () => {
  const get = () => GET(new NextRequest("http://enki.test/api/admin", { headers: { "X-Session-Token": "admin-tok" } }));

  it("shows the ban that holds and the appeal against it", async () => {
    tables.bans.push(
      { id: "perm", user_id: "u1", lifted_at: null, expires_at: null, created_at: ago(1), reason: "Council: spam" },
      { id: "short", user_id: "u1", lifted_at: null, expires_at: ago(-3), created_at: ago(0), reason: "ladder" },
    );
    tables.appeals.push(
      { id: "a-short", user_id: "u1", target_uuid: "short", status: "pending", user_statement: "about the 3 days", created_at: ago(2) },
      { id: "a-perm", user_id: "u1", target_uuid: "perm", status: "pending", user_statement: "about the council", created_at: ago(1) },
    );
    const row = ((await (await get()).json()).strikes as Record<string, unknown>[]).find((r) => r.userId === "u1");
    expect(row).toMatchObject({ banned: true, permanent: true, appeal: { id: "a-perm" } });
  });

  it("lets a different manual ban stand beside a longer running one", async () => {
    tables.bans.push({ id: "b1", user_id: "u1", lifted_at: null, expires_at: null, created_at: ago(0), reason: "Council: spam" });
    const res = await POST(new NextRequest("http://enki.test/api/admin", {
      method: "POST", headers: { "X-Session-Token": "admin-tok", "Content-Type": "application/json" },
      body: JSON.stringify({ resource: "bans", action: "ban", userId: "u1", days: 30 }),
    }));
    expect(res.status).toBe(200);
    expect(tables.bans).toHaveLength(2);
  });
});

describe("the strikes tab, appeal order", () => {
  it("prefers the appeal against the ban that holds even when another is newer", async () => {
    tables.bans.push(
      { id: "perm", user_id: "u1", lifted_at: null, expires_at: null, created_at: ago(5), reason: "Council: spam" },
      { id: "short", user_id: "u1", lifted_at: null, expires_at: ago(-3), created_at: ago(0), reason: "ladder" },
    );
    tables.appeals.push(
      { id: "a-perm", user_id: "u1", target_uuid: "perm", status: "pending", user_statement: "council", created_at: ago(4) },
      { id: "a-short", user_id: "u1", target_uuid: "short", status: "pending", user_statement: "3 days", created_at: ago(0) },
    );
    const res = await GET(new NextRequest("http://enki.test/api/admin", { headers: { "X-Session-Token": "admin-tok" } }));
    const row = ((await res.json()).strikes as Record<string, unknown>[]).find((r) => r.userId === "u1");
    expect(row).toMatchObject({ appeal: { id: "a-perm" } });
  });
});

describe("the strikes tab, many bans", () => {
  const get = async () => ((await (await GET(new NextRequest("http://enki.test/api/admin", { headers: { "X-Session-Token": "admin-tok" } }))).json()).strikes as Record<string, unknown>[]);

  it("keeps the ban that holds even when the list is cut at 100", async () => {
    for (let i = 0; i < 120; i++) tables.bans.push({ id: `t${i}`, user_id: "u2", lifted_at: null, expires_at: ago(-1 - i / 1000), created_at: ago(0), reason: "short" });
    tables.bans.push({ id: "perm", user_id: "u1", lifted_at: null, expires_at: null, created_at: ago(9), reason: "Council: spam" });
    expect((await get()).find((r) => r.userId === "u1")).toMatchObject({ banned: true, permanent: true });
  });

  it("shows which ban an appeal is against", async () => {
    tables.bans.push(
      { id: "perm", user_id: "u1", lifted_at: null, expires_at: null, created_at: ago(5), reason: "Council: spam" },
      { id: "short", user_id: "u1", lifted_at: null, expires_at: ago(-3), created_at: ago(0), reason: "ladder" },
    );
    tables.appeals.push({ id: "a-short", user_id: "u1", target_uuid: "short", status: "pending", user_statement: "3 days", created_at: ago(0) });
    const row = (await get()).find((r) => r.userId === "u1");
    expect(row).toMatchObject({ appeal: { id: "a-short", against: { reason: "ladder" } } });
  });
});
