import { describe, it, expect, beforeEach } from "vitest";
import { DB_UNAVAILABLE_MESSAGE } from "@/lib/db-error";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeQuote } from "@/lib/payments/generation-quote";

/**
 * Only a live prompt is for sale. The agent rail refused a draft, a deleted
 * or a delisted prompt, but the quote every human payment prices through
 * never looked at the prompt's state: anyone who knew the id could still buy
 * a prompt an admin had taken down after a report. Its creator is let
 * through to their own, since the generator page opens for it.
 */

type Row = Record<string, unknown>;
let db: Record<string, Row[]>;
let reads: string[];
let failing: string | null;
/** How a failing table fails: a dead host by default, any other error when a test says so. */
let failWith: string;

/** A reader that applies its filters and returns only the selected columns, as PostgREST does. */
class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: ((r: Row) => boolean)[] = [];
  private cols: string[] | null = null;
  private one = false;
  constructor(private table: string) {}
  select(c: string) { this.cols = c.split(",").map((x) => x.trim()); return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: null) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  gt(c: string, v: string) { this.filters.push((r) => String(r[c]) > v); return this; }
  or(expr: string) {
    // Only the active-ban shape is used: "expires_at.is.null,expires_at.gt.<iso>".
    const iso = expr.split("expires_at.gt.")[1];
    this.filters.push((r) => r.expires_at == null || String(r.expires_at) > iso);
    return this;
  }
  order() { return this; }
  limit() { return this; }
  lte() { return this; }
  gte() { return this; }
  maybeSingle() { this.one = true; return this; }
  then<A, B = never>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    reads.push(this.table);
    if (failing === this.table) return Promise.resolve({ data: null, error: { message: failWith } }).then(ok, ko);
    const cols = this.cols;
    const rows = (db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)))
      .map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r));
    return Promise.resolve({ data: this.one ? rows[0] ?? null : rows, error: null }).then(ok, ko);
  }
}
const fake = { from: (t: string) => new Query(t) } as unknown as SupabaseClient;

const ARTIST = "aaaaaaaa-1111-4111-8111-111111111111";
const BUYER = "bbbbbbbb-2222-4222-8222-222222222222";
const EMAIL = "eeeeeeee-3333-4333-8333-333333333333";
const FIRST_MAPPING = "ffffffff-4444-4444-8444-444444444444";
const future = new Date(Date.now() + 86400_000).toISOString();
const LIVE = { is_listed: true, listing_status: "active", deleted_at: null };
const NOT_LIVE: [string, Row][] = [
  ["a draft", { is_listed: false, listing_status: "draft", deleted_at: null }],
  ["a deleted prompt", { ...LIVE, deleted_at: "2026-10-01T00:00:00Z" }],
  // An admin delist clears is_listed and leaves the status as it was.
  ["a prompt an admin delisted", { is_listed: false, listing_status: "active", deleted_at: null }],
];

const quote = (sessionToken?: string) =>
  computeQuote(fake, { promptId: "p1", modelFamily: "nano-banana-pro", resolution: "2K", sessionToken });
const prompt = (state: Row, creator = ARTIST) => {
  db.prompts = [{ id: "p1", price_usd_cents: 150, creator_id: creator, prompt_type: "paid", is_free_showcase: false, ...state }];
};

beforeEach(() => {
  reads = [];
  failing = null;
  failWith = "TypeError: fetch failed";
  db = {
    prompts: [],
    auth_sessions: [
      { token: "artist", wallet_address: "ArtistWa11et1111111111111111111111111111111", expires_at: future },
      { token: "buyer", wallet_address: "BuyerWa11et11111111111111111111111111111111", expires_at: future },
      // An email login carries its users.id as the session address.
      { token: "email", wallet_address: EMAIL, expires_at: future },
    ],
    user_wallets: [
      { address: "ArtistWa11et1111111111111111111111111111111", user_id: ARTIST, chain_family: "solana", removed_at: null },
      { address: "BuyerWa11et11111111111111111111111111111111", user_id: BUYER, chain_family: "solana", removed_at: null },
      // The email creator's first save mapped their address to another user, who holds their prompts.
      { address: EMAIL, user_id: FIRST_MAPPING, chain_family: "other", removed_at: null },
      { address: "MappedWa11et1111111111111111111111111111111", user_id: FIRST_MAPPING, chain_family: "solana", removed_at: null },
    ],
    bans: [],
    users: [{ id: ARTIST, deleted_at: null, account_status: "active" }],
  };
});

describe.each(NOT_LIVE)("%s", (_name, state) => {
  beforeEach(() => prompt(state));

  it("is not for sale to a visitor without a session", async () => {
    expect(await quote()).toEqual({ ok: false, status: 404, error: "Prompt not found" });
  });

  it("is not for sale to another signed-in buyer", async () => {
    expect(await quote("buyer")).toEqual({ ok: false, status: 404, error: "Prompt not found" });
  });

  it("is still quoted to its creator", async () => {
    const q = await quote("artist");
    if (!q.ok) throw new Error(q.error);
    expect(q.split.artistAmountMicro).toBe(1_500_000);
  });
});

describe("a live prompt", () => {
  it("is quoted to anyone, without looking at a session", async () => {
    prompt(LIVE);
    const q = await quote("buyer");
    if (!q.ok) throw new Error(q.error);
    expect(q.split.artistAmountMicro).toBe(1_500_000);
    expect(reads).not.toContain("auth_sessions");
  });
});

describe("a live prompt of a banned or deleted creator", () => {
  beforeEach(() => prompt(LIVE));

  it("is not for sale while the ban is active", async () => {
    db.bans.push({ id: "b1", user_id: ARTIST, lifted_at: null, expires_at: null, reason: "x" });
    expect(await quote()).toEqual({ ok: false, status: 404, error: "Prompt not found" });
    expect(await quote("buyer")).toEqual({ ok: false, status: 404, error: "Prompt not found" });
  });

  it("is for sale again once the ban is lifted", async () => {
    db.bans.push({ id: "b1", user_id: ARTIST, lifted_at: "2026-10-01T00:00:00Z", expires_at: null, reason: "x" });
    expect((await quote("buyer")).ok).toBe(true);
  });

  it("is not for sale once the account is deleted", async () => {
    db.users = [{ id: ARTIST, deleted_at: "2026-10-01T00:00:00Z", account_status: "deleted" }];
    expect(await quote("buyer")).toEqual({ ok: false, status: 404, error: "Prompt not found" });
  });

  it("is not sold blind while the creators cannot be read: an outage when the database is down", async () => {
    failing = "bans";
    expect(await quote("buyer")).toEqual({ ok: false, status: 503, error: DB_UNAVAILABLE_MESSAGE, code: "DB_UNAVAILABLE" });
    failWith = "permission denied for table bans";
    expect(await quote("buyer")).toEqual({ ok: false, status: 500, error: "Failed to load prompt" });
  });

  it("answers an outage while reading the prompt itself with 503, not 'failed to load'", async () => {
    failing = "prompts";
    expect(await quote("buyer")).toEqual({ ok: false, status: 503, error: DB_UNAVAILABLE_MESSAGE, code: "DB_UNAVAILABLE" });
  });
});

describe("who counts as the creator of a prompt that is not live", () => {
  it("an email creator whose prompt sits with the user their address was first mapped to", async () => {
    prompt(NOT_LIVE[0][1], FIRST_MAPPING);
    expect((await quote("email")).ok).toBe(true);
  });

  it("not a suspended creator", async () => {
    prompt(NOT_LIVE[0][1]);
    db.bans.push({ id: "b1", user_id: ARTIST, lifted_at: null, expires_at: null, reason: "x" });
    expect(await quote("artist")).toMatchObject({ ok: false, status: 404 });
  });

  it("nobody while the session cannot be read: an outage answers 503, any other failure 404", async () => {
    prompt(NOT_LIVE[0][1]);
    failing = "auth_sessions";
    expect(await quote("artist")).toMatchObject({ ok: false, status: 503, code: "DB_UNAVAILABLE" });
    failWith = "permission denied for table auth_sessions";
    expect(await quote("artist")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("every human payment prices through this check", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

  it("the quote and the intent route hand the session to the quote", () => {
    expect(read("app", "api", "payments", "generation", "intent", "route.ts")).toMatch(/buyer: authUser\.userId,\n\s+sessionToken: req\.headers\.get\("X-Session-Token"\),\n\s+\}\);/);
    const quoteRoute = read("app", "api", "payments", "generation", "quote", "route.ts");
    expect(quoteRoute).toMatch(/buyer: user\.userId,\n\s+sessionToken: user\.sessionToken,\n\s+\}\);/);
    expect(quoteRoute).toMatch(/authUser = \{ \.\.\.\(await requireAuth\(req\)\), sessionToken: req\.headers\.get\("X-Session-Token"\) \};/);
  });

  it("the intent route is the only writer of payment intents", () => {
    // Authorise, submit and generate read the intent alone, so what the intent refuses they never see.
    for (const step of ["authorize", "submit"]) {
      expect(read("app", "api", "payments", "generation", step, "route.ts")).not.toMatch(/\.insert\(/);
    }
    expect(read("app", "api", "payments", "generation", "intent", "route.ts")).toMatch(/\.from\("generation_payment_intents"\)\s*\.insert\(/);
  });
});
