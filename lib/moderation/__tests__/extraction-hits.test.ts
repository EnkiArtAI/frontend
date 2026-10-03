import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A caught extraction attempt is recorded quietly (Kev, 2026-10-02): the
 * buyer sees an ordinary failure, the team gets the case, and the third hit
 * within 30 days blocks. Accounts are banned; agents, which have no account,
 * are stopped by hashed IP.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

class Query implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private filters: ((r: Row) => boolean)[] = [];
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private countOnly = false;
  constructor(private table: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) { if (opts?.head) this.countOnly = true; return this; }
  insert(row: Row) { this.op = "insert"; this.payload = row; return this; }
  update(row: Row) { this.op = "update"; this.payload = row; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  is(c: string, v: null) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  gte(c: string, v: string) { this.filters.push((r) => String(r[c]) >= v); return this; }
  limit() { return this; }
  maybeSingle() { return this; }
  single() { return this; }
  then<A, B = never>(ok?: ((v: { data: unknown; error: null; count?: number }) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, ko);
  }
  private run() {
    const rows = (tables[this.table] ??= []);
    if (this.op === "insert") {
      const row = { id: `${this.table}-${rows.length + 1}`, created_at: new Date().toISOString(), ...this.payload };
      rows.push(row);
      return { data: { id: row.id }, error: null };
    }
    const hits = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") { hits.forEach((r) => Object.assign(r, this.payload)); return { data: null, error: null }; }
    if (this.countOnly) return { data: null, error: null, count: hits.length };
    return { data: this.table === "moderation_policy" ? hits[0] ?? null : hits, error: null };
  }
}
const fake = { from: (t: string) => new Query(t) } as unknown as SupabaseClient;

const notify = vi.fn(async (_s: unknown, _m: { subject: string; text: string }) => {});
vi.mock("@/lib/admin-notify", () => ({ notifyAdmins: (s: unknown, m: { subject: string; text: string }) => notify(s, m) }));
vi.mock("@/lib/crypto", () => ({ encryptString: () => ({ encrypted: "ct", iv: "iv", authTag: "tag", kid: "k1" }) }));
vi.mock("@/lib/ip-hash", () => ({
  getClientIp: (r: { headers: { get(n: string): string | null } }) => r.headers.get("x-forwarded-for"),
  hashIp: (ip: string | null) => (ip ? `h:${ip}` : null),
}));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async (_s: unknown, token: string | null) => (token === "buyer-token" ? "buyer-1" : null),
  activeBanFor: async (_s: unknown, userId: string) =>
    tables.bans.find((b) => b.user_id === userId && !b.lifted_at && (!b.expires_at || String(b.expires_at) > new Date().toISOString())) ?? null,
}));

import { recordExtractionHit, agentBlocked, EXTRACTION_HITS_TO_BLOCK, SILENT_FAILURE, SILENT_DELAY_MS, silentFailure } from "@/lib/moderation/extraction-hits";

const buyer = { headers: new Headers({ "X-Session-Token": "buyer-token", "x-forwarded-for": "1.2.3.4" }) };
const agent = { headers: new Headers({ "x-forwarded-for": "9.9.9.9" }) };
const VALUES = { subject: "a poster with the complete original description" };
const hit = (request: { headers: Headers }) =>
  recordExtractionHit(fake, { surface: "generate-image", request, values: VALUES, confidence: 0.92 });

beforeEach(() => {
  notify.mockClear();
  tables = { moderation_policy: [{ id: 1, owner_user_id: "owner-1" }], bans: [], automod_events: [] };
});

describe("a caught attempt", () => {
  it("lands in the review queue as an extraction strike", async () => {
    await hit(buyer);
    expect(tables.automod_events[0]).toMatchObject({
      user_id: "buyer-1", category: "extraction", decision: "block", severity: "strike", review_state: "pending",
    });
  });

  it("keeps the values only encrypted", async () => {
    await hit(buyer);
    expect(JSON.stringify(tables.automod_events[0])).not.toContain("original description");
    expect(tables.automod_events[0].evidence_ct).toBe("ct");
  });

  it("tells the team", async () => {
    await hit(buyer);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("never mails the inputs themselves", async () => {
    await hit(buyer);
    expect(JSON.stringify(notify.mock.calls[0][1])).not.toContain("original description");
  });

  it("does not ban before the threshold", async () => {
    for (let i = 1; i < EXTRACTION_HITS_TO_BLOCK; i++) await hit(buyer);
    expect(tables.bans).toEqual([]);
  });

  it(`bans the account at hit ${EXTRACTION_HITS_TO_BLOCK}, in the moderation owner's name`, async () => {
    for (let i = 0; i < EXTRACTION_HITS_TO_BLOCK; i++) await hit(buyer);
    expect(tables.bans).toEqual([expect.objectContaining({ user_id: "buyer-1", issued_by: "owner-1", scope: "full" })]);
  });

  it("never stacks a second ban", async () => {
    for (let i = 0; i < EXTRACTION_HITS_TO_BLOCK + 2; i++) await hit(buyer);
    expect(tables.bans).toHaveLength(1);
  });

  it("is not prevented by a suspension that has run out", async () => {
    tables.bans.push({ user_id: "buyer-1", lifted_at: null, expires_at: new Date(Date.now() - 60_000).toISOString() });
    for (let i = 0; i < EXTRACTION_HITS_TO_BLOCK; i++) await hit(buyer);
    expect(tables.bans).toHaveLength(2);
  });

  it("does not count hits older than 30 days", async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < EXTRACTION_HITS_TO_BLOCK - 1; i++) {
      tables.automod_events.push({ user_id: "buyer-1", category: "extraction", created_at: old });
    }
    await hit(buyer);
    expect(tables.bans).toEqual([]);
  });
});

describe("an agent", () => {
  it("is not blocked before the threshold", async () => {
    for (let i = 1; i < EXTRACTION_HITS_TO_BLOCK; i++) await hit(agent);
    expect(await agentBlocked(fake, agent)).toBe(false);
  });

  it("is stopped by address at the threshold", async () => {
    for (let i = 0; i < EXTRACTION_HITS_TO_BLOCK; i++) await hit(agent);
    expect(await agentBlocked(fake, agent)).toBe(true);
  });

  it("does not inherit an account's hits from the same address", async () => {
    for (let i = 0; i < EXTRACTION_HITS_TO_BLOCK; i++) await hit({ headers: new Headers({ "X-Session-Token": "buyer-token", "x-forwarded-for": "9.9.9.9" }) });
    expect(await agentBlocked(fake, agent)).toBe(false);
  });
});

describe("what the buyer sees", () => {
  it("is an ordinary failure that names no check", () => {
    expect(JSON.stringify(SILENT_FAILURE)).not.toMatch(/extract|check|detect|policy|moderat/i);
  });

  it("takes as long as a generation that fails", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const answer = silentFailure().then((r) => { done = true; return r; });
      await vi.advanceTimersByTimeAsync(SILENT_DELAY_MS.min - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(SILENT_DELAY_MS.max);
      const res = await answer;
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(SILENT_FAILURE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not given away later by the ban reason", async () => {
    for (let i = 0; i < EXTRACTION_HITS_TO_BLOCK; i++) await hit(buyer);
    expect(String(tables.bans[0].reason)).not.toMatch(/extract|prompt|check|detect|attempt/i);
  });
});
