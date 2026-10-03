import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSource } from "@/lib/__tests__/_read-source";
import { listPeople, personDetail } from "@/lib/admin/people";

/**
 * The admin person list (Kev, 2026-10-03): one row per person with what
 * enforcement counts, and every event with its prompt and settings on
 * expanding, so whoever is failing on what can be fixed fast.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filters: ((r: Row) => boolean)[] = [];
  private cap = Infinity;
  private desc = false;
  constructor(private table: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: null) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, _op: string, v: null) { this.filters.push((r) => (r[c] ?? null) !== v); return this; }
  gte(c: string, v: string) { this.filters.push((r) => String(r[c]) >= v); return this; }
  or(expr: string) {
    // Only the active-ban shape is used: "expires_at.is.null,expires_at.gt.<iso>".
    const iso = expr.split("expires_at.gt.")[1];
    this.filters.push((r) => r.expires_at == null || String(r.expires_at) > iso);
    return this;
  }
  order(_c: string, o: { ascending: boolean }) { this.desc = !o.ascending; return this; }
  limit(n: number) { this.cap = n; return this; }
  then<A, B = never>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    let rows = (tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    if (this.desc) rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return Promise.resolve({ data: rows.slice(0, this.cap), error: null }).then(ok, ko);
  }
}
const fake = { from: (t: string) => new Query(t) } as unknown as SupabaseClient;

const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
const ev = (user: string, category: string, extra: Row = {}): Row => ({
  id: `e${Math.random()}`, user_id: user, decision: "block", category, review_state: "none", scores: { weight: category === "minor_sexual" ? 10 : 1 }, created_at: ago(1), ...extra,
});

beforeEach(() => {
  tables = {
    automod_events: [], generation_failures: [], bans: [], generations: [], models: [{ id: "m1", name: "GPT Image 2" }],
    users: [{ id: "u1", handle: "anna", display_name: "Anna" }, { id: "u2", handle: "ben", display_name: null }],
  };
});

describe("the person list", () => {
  it("counts warnings the way enforcement does", async () => {
    tables.automod_events.push(ev("u1", "explicit_sexual"), ev("u1", "explicit_sexual"), ev("u1", "explicit_sexual", { review_state: "overturned" }));
    const [anna] = await listPeople(fake);
    expect(anna).toMatchObject({ userId: "u1", handle: "anna", warnings: 2 });
  });

  it("flags a child-safety case that was not overturned", async () => {
    tables.automod_events.push(ev("u1", "minor_sexual", { review_state: "pending" }));
    const [anna] = await listPeople(fake);
    expect(anna).toMatchObject({ childSafety: true, pending: 1, warnings: 10 });
  });

  it("drops the flag once the case is overturned", async () => {
    tables.automod_events.push(ev("u1", "minor_sexual", { review_state: "overturned" }));
    expect((await listPeople(fake))[0].childSafety).toBe(false);
  });

  it("counts extraction hits of the last 30 days only", async () => {
    tables.automod_events.push(ev("u1", "extraction"), ev("u1", "extraction", { created_at: ago(40) }));
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

  it("puts the most recently active person first", async () => {
    tables.automod_events.push(ev("u1", "explicit_sexual", { created_at: ago(5) }), ev("u2", "explicit_sexual", { created_at: ago(1) }));
    expect((await listPeople(fake)).map((p) => p.userId)).toEqual(["u2", "u1"]);
  });

  it("counts a recent generation as activity", async () => {
    tables.automod_events.push(ev("u1", "explicit_sexual", { created_at: ago(5) }), ev("u2", "explicit_sexual", { created_at: ago(2) }));
    tables.generations.push({ user_id: "u1", created_at: ago(0) });
    expect((await listPeople(fake)).map((p) => p.userId)).toEqual(["u1", "u2"]);
  });

  it("is empty when nobody needs looking at", async () => {
    expect(await listPeople(fake)).toEqual([]);
  });
});

describe("one person, expanded", () => {
  const decrypt = (ct: unknown) => (ct === "secret" ? "the decrypted prompt" : null);

  it("shows every event with its prompt, weight and state", async () => {
    tables.automod_events.push(ev("u1", "explicit_sexual", { evidence_ct: "secret", surface: "generate-image", severity: "strike", tier: 2, scores: { weight: 1, confidence: 0.92 } }));
    const d = await personDetail(fake, "u1", decrypt);
    expect(d.events[0]).toMatchObject({ category: "explicit_sexual", prompt: "the decrypted prompt", weight: 1, confidence: 0.92, state: "none" });
  });

  it("shows a failure with its settings, error and model name", async () => {
    tables.generation_failures.push({
      id: "f1", user_id: "u1", surface: "generate-image", model_id: "m1", resolution: "2K", quality: "high", boost: false,
      aspect_ratio: "16:9", reference_image_count: 2, error: "provider said no", prompt_ct: "secret", created_at: ago(1),
    });
    const d = await personDetail(fake, "u1", decrypt);
    expect(d.failures[0]).toMatchObject({
      model: "GPT Image 2", resolution: "2K", quality: "high", aspectRatio: "16:9", referenceImageCount: 2, error: "provider said no", prompt: "the decrypted prompt",
    });
  });

  it("shows only that person's events", async () => {
    tables.automod_events.push(ev("u2", "explicit_sexual"));
    expect((await personDetail(fake, "u1", decrypt)).events).toEqual([]);
  });
});

describe("the admin route", () => {
  const SRC = readSource(join(__dirname, "..", "..", "app", "api", "admin", "route.ts"));

  it("answers one person's detail for a valid id only", () => {
    expect(SRC).toMatch(/if \(!UUID_RE\.test\(person\)\) return NextResponse\.json\(\{ error: "Bad person id" \}, \{ status: 400 \}\);/);
  });

  it("sends the person list with the panel's data", () => {
    expect(SRC).toMatch(/listPeople\(supabase\),\n {2}\]\);/);
    expect(SRC).toMatch(/return NextResponse\.json\(\{\n {4}people,/);
  });

  it("lets only an admin review a child-safety case", () => {
    expect(SRC).toMatch(/if \(CHILD_SAFETY\.includes\(String\(ev\.category\)\) && role !== "admin"\) \{/);
  });

  it("overturns or upholds without deleting the event", () => {
    expect(SRC).toMatch(/review_state: body\.action === "overturn" \? "overturned" : "upheld",/);
    expect(SRC).not.toMatch(/from\("automod_events"\)\s*\.delete\(/);
  });
});
