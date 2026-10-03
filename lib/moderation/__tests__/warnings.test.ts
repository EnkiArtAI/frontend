import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Visible warnings and the suspension ladder (Kev, 2026-10-03): every tenth
 * warning suspends for the next step, 3 days, 7 days, 1 month, 2 months,
 * 6 months, 1 year, for good. A child-safety request weighs ten warnings.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filters: ((r: Row) => boolean)[] = [];
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  constructor(private table: string) {}
  select() { return this; }
  insert(row: Row) { this.op = "insert"; this.payload = row; return this; }
  update(row: Row) { this.op = "update"; this.payload = row; return this; }
  single() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: null) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  gte(c: string, v: string) { this.filters.push((r) => String(r[c]) >= v); return this; }
  maybeSingle() { return this; }
  limit() { return this; }
  order() { return this; }
  or(expr: string) {
    // Only the active-ban shape is used: "expires_at.is.null,expires_at.gt.<iso>".
    const iso = expr.split("expires_at.gt.")[1];
    this.filters.push((r) => r.expires_at == null || String(r.expires_at) > iso);
    return this;
  }
  then<A, B = never>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
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
    return { data: this.table === "moderation_policy" ? hits[0] ?? null : hits, error: null };
  }
}
const fake = { from: (t: string) => new Query(t) } as unknown as SupabaseClient;

const notify = vi.fn(async () => {});
vi.mock("@/lib/admin-notify", () => ({ notifyAdmins: () => notify() }));
const sealed = vi.fn((_plain: string, _aad?: string) => ({ encrypted: "ct", iv: "iv", authTag: "tag", kid: "k1" }));
vi.mock("@/lib/crypto", () => ({ encryptString: (p: string, a?: string) => sealed(p, a) }));
vi.mock("@/lib/ip-hash", () => ({
  getClientIp: (r: { headers: { get(n: string): string | null } }) => r.headers.get("x-forwarded-for"),
  hashIp: (ip: string | null) => (ip ? `h:${ip}` : null),
}));
// "suspended-token" belongs to a suspended account: the plain resolver hides it.
const SESSIONS: Record<string, { userId: string; ban: { id: string } | null }> = {
  "user-token": { userId: "user-1", ban: null },
  "suspended-token": { userId: "user-2", ban: { id: "b1" } },
};
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async (_s: unknown, token: string | null) => (SESSIONS[token ?? ""]?.ban ? null : SESSIONS[token ?? ""]?.userId ?? null),
  resolveSessionUserWithBan: async (_s: unknown, token: string | null) => SESSIONS[token ?? ""] ?? { userId: null, ban: null },
  activeBanFor: async (_s: unknown, userId: string) => {
    const b = tables.bans?.find((x) => x.user_id === userId && !x.lifted_at && (!x.expires_at || String(x.expires_at) > new Date().toISOString()));
    return b ? { id: String(b.id), reason: null, expiresAt: (b.expires_at as string | null) ?? null } : null;
  },
}));

import { recordWarning, warningMessage, addressWarnedOut, WARNINGS_PER_STEP, SUSPENSION_LADDER_DAYS } from "@/lib/moderation/warnings";

const user = { headers: new Headers({ "X-Session-Token": "user-token", "x-forwarded-for": "1.2.3.4" }) };
const anon = { headers: new Headers({ "x-forwarded-for": "9.9.9.9" }) };
const DAY = 24 * 60 * 60 * 1000;
const warn = (request: { headers: Headers }, category: "explicit_sexual" | "minor_sexual" = "explicit_sexual") =>
  recordWarning(fake, { surface: "generate-image", request, category, text: "an explicit request", confidence: 0.9 });
const daysOf = (ban: Row) => Math.round((Date.parse(String(ban.expires_at)) - Date.now()) / DAY);

beforeEach(() => {
  notify.mockClear();
  tables = { moderation_policy: [{ id: 1, owner_user_id: "owner-1" }], bans: [], automod_events: [] };
});

describe("a warning", () => {
  it("is recorded with its weight and the text encrypted", async () => {
    await warn(user);
    expect(tables.automod_events[0]).toMatchObject({ user_id: "user-1", category: "explicit_sexual", decision: "block", scores: { weight: 1 } });
    expect(JSON.stringify(tables.automod_events[0])).not.toContain("an explicit request");
  });

  it("seals an artist's words apart from what moderators read", async () => {
    await recordWarning(fake, { surface: "upload", request: user, category: "explicit_sexual", text: '{"title":"Moody"}', withheld: "the artist's words", confidence: 0.9 });
    const [plain, aad] = sealed.mock.calls.at(-1)!;
    expect(aad).toBe("moderation-evidence/v1");
    expect(JSON.parse(plain)).toMatchObject({ shown: '{"title":"Moody"}', withheld: "the artist's words" });
  });

  it("does not suspend before the tenth", async () => {
    for (let i = 1; i < WARNINGS_PER_STEP; i++) await warn(user);
    expect(tables.bans).toEqual([]);
  });

  it("does not mail the team for a plain warning", async () => {
    await warn(user);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("the suspension ladder", () => {
  it("pins the decided steps", () => {
    expect(SUSPENSION_LADDER_DAYS).toEqual([3, 7, 30, 60, 180, 365, null]);
  });

  it("suspends for 3 days at the tenth warning", async () => {
    for (let i = 0; i < 10; i++) await warn(user);
    expect(tables.bans).toHaveLength(1);
    expect(daysOf(tables.bans[0])).toBe(3);
  });

  it("suspends for 7 days at the twentieth, as its own row beside a 3-day one still running", async () => {
    for (let i = 0; i < 20; i++) await warn(user);
    expect(tables.bans.map(daysOf)).toEqual([3, 7]);
  });

  it("starts a new suspension once the last one has run out", async () => {
    for (let i = 0; i < 10; i++) await warn(user);
    tables.bans[0].expires_at = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 10; i++) await warn(user);
    expect(tables.bans).toHaveLength(2);
    expect(daysOf(tables.bans[1])).toBe(7);
  });

  it("suspends for good at the seventieth", async () => {
    for (let i = 0; i < 70; i++) await warn(user);
    expect(tables.bans.at(-1)).toMatchObject({ expires_at: null });
  });

  it("issues each suspension in the moderation owner's name", async () => {
    for (let i = 0; i < 10; i++) await warn(user);
    expect(tables.bans[0]).toMatchObject({ user_id: "user-1", issued_by: "owner-1", scope: "full" });
  });

  it("mails the team when it suspends", async () => {
    for (let i = 0; i < 10; i++) await warn(user);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("leaves an overturned warning out of the count", async () => {
    for (let i = 0; i < 9; i++) await warn(user);
    tables.automod_events[0].review_state = "overturned";
    await warn(user);
    expect(tables.bans).toEqual([]);
  });
});

describe("a child-safety request", () => {
  it("weighs ten warnings, so the first one suspends", async () => {
    await warn(user, "minor_sexual");
    expect(daysOf(tables.bans[0])).toBe(3);
  });

  it("goes to the review queue", async () => {
    await warn(user, "minor_sexual");
    expect(tables.automod_events[0]).toMatchObject({ review_state: "pending", scores: { weight: 10 } });
  });
});

describe("a request without an account", () => {
  it("never creates a ban", async () => {
    for (let i = 0; i < 10; i++) await warn(anon);
    expect(tables.bans).toEqual([]);
  });

  it("stops the address at the first step", async () => {
    for (let i = 0; i < 9; i++) await warn(anon);
    expect(await addressWarnedOut(fake, anon)).toBe(false);
    await warn(anon);
    expect(await addressWarnedOut(fake, anon)).toBe(true);
  });

  it("forgets an address's warnings after 30 days", async () => {
    const old = new Date(Date.now() - 31 * DAY).toISOString();
    for (let i = 0; i < 10; i++) tables.automod_events.push({ ip_hash: "h:9.9.9.9", category: "explicit_sexual", review_state: "none", scores: { weight: 1 }, created_at: old });
    expect(await addressWarnedOut(fake, anon)).toBe(false);
  });
});

describe("what the user reads", () => {
  it("counts down to the next suspension", () => {
    expect(warningMessage("explicit_sexual", { total: 3, suspendedUntil: null, nextStepAt: 10 }))
      .toBe("Explicit sexual content isn't allowed on Enki. Nothing was generated and nothing was charged. This is warning 3 of 10; at 10 your account is suspended for 3 days.");
  });

  it("names the next step's length after a suspension", () => {
    expect(warningMessage("explicit_sexual", { total: 12, suspendedUntil: null, nextStepAt: 20 })).toMatch(/at 20 your account is suspended for 7 days\.$/);
  });

  it("says when a suspension ends", () => {
    expect(warningMessage("minor_sexual", { total: 10, suspendedUntil: "2026-10-06T12:00:00.000Z", nextStepAt: 20 }))
      .toBe("Sexual content involving minors is strictly prohibited. Nothing was generated and nothing was charged. Your account is suspended until 2026-10-06.");
  });

  it("says when it is for good", () => {
    expect(warningMessage("explicit_sexual", { total: 70, suspendedUntil: "forever", nextStepAt: 80 })).toMatch(/suspended for good\.$/);
  });
});

describe("a suspended account", () => {
  it("still gets its warnings, child-safety ones included, not its address", async () => {
    await recordWarning(fake, {
      surface: "generate-image", request: { headers: new Headers({ "X-Session-Token": "suspended-token", "x-forwarded-for": "5.5.5.5" }) },
      category: "minor_sexual", text: "t", confidence: 0.9,
    });
    expect(tables.automod_events.at(-1)?.user_id).toBe("user-2");
  });
});

describe("a step during a running longer ban", () => {
  it("is its own row, and reports the end that holds", async () => {
    const until = new Date(Date.now() + 60 * DAY).toISOString();
    tables.bans.push({ id: "running", user_id: "user-1", lifted_at: null, expires_at: until });
    // The real activeBanFor reports the longest; this mock finds the only one.
    let outcome;
    for (let i = 0; i < WARNINGS_PER_STEP; i++) {
      outcome = await recordWarning(fake, { surface: "generate-image", request: user, category: "explicit_sexual", text: "t", confidence: 0.9 });
    }
    // Its own row, so an appeal against the longer ban leaves this one standing.
    expect(tables.bans).toHaveLength(2);
    expect(tables.bans[0].expires_at).toBe(until);
    expect(outcome?.suspendedUntil).toBe(until);
  });
});

describe("a suspension that cannot be written", () => {
  it("still answers the warning", async () => {
    tables.moderation_policy = [{ id: 1, owner_user_id: "owner-1" }];
    const failing = { from: (t: string) => (t === "bans" ? (() => { throw new Error("fetch failed"); })() : new Query(t)) } as unknown as SupabaseClient;
    let outcome;
    for (let i = 0; i < WARNINGS_PER_STEP; i++) {
      outcome = await recordWarning(failing, { surface: "generate-image", request: user, category: "explicit_sexual", text: "t", confidence: 0.9 });
    }
    expect(outcome).toMatchObject({ total: WARNINGS_PER_STEP, suspendedUntil: null });
  });
});

describe("a banned account that keeps going", () => {
  it("collects at most one row per ladder step, however long it goes on", async () => {
    for (let i = 0; i < 30; i++) {
      await recordWarning(fake, { surface: "generate-free", request: user, category: "minor_sexual", text: "t", confidence: 0.9 });
    }
    expect(tables.bans.length).toBeLessThanOrEqual(SUSPENSION_LADDER_DAYS.length);
    expect(new Set(tables.bans.map((b) => b.reason)).size).toBe(tables.bans.length);
  });
});

describe("the shared warning count", () => {
  it("adds the weights of warning categories and skips overturned ones", async () => {
    const { warningWeight } = await import("@/lib/moderation/warnings");
    expect(warningWeight([
      { category: "explicit_sexual", review_state: "none", scores: { weight: 1 } },
      { category: "minor_sexual", review_state: "pending", scores: { weight: 10 } },
      { category: "explicit_sexual", review_state: "overturned", scores: { weight: 1 } },
      { category: "extraction", review_state: "none", scores: { weight: 5 } },
    ])).toBe(11);
  });
});
