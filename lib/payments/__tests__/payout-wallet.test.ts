import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { artistPayoutWallet, computeQuote } from "@/lib/payments/generation-quote";

/**
 * Where an artist's share is paid: the creator's live Solana wallet, from the
 * database. One rule for the quote and for the release of a paid prompt.
 */

type Row = Record<string, unknown>;
let db: Record<string, Row[]>;
let failing: string | null;

/** A reader that applies its filters and returns only the selected columns, as PostgREST does. */
class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: ((r: Row) => boolean)[] = [];
  private cols: string[] | null = null;
  private one = false;
  constructor(private table: string) {}
  select(c: string) { this.cols = c.split(",").map((x) => x.trim()); return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  is(c: string, v: null) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  limit() { return this; }
  maybeSingle() { this.one = true; return this; }
  then<A, B = never>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    if (failing === this.table) return Promise.resolve({ data: null, error: { message: "TypeError: fetch failed" } }).then(ok, ko);
    const cols = this.cols;
    const rows = (db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)))
      .map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r));
    return Promise.resolve({ data: this.one ? rows[0] ?? null : rows, error: null }).then(ok, ko);
  }
}
const fake = { from: (t: string) => new Query(t) } as unknown as SupabaseClient;

const ARTIST = "aaaaaaaa-1111-4111-8111-111111111111";
const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const wallet = (extra: Row = {}) => ({ user_id: ARTIST, address: SOLANA, chain_family: "solana", removed_at: null, ...extra });

beforeEach(() => {
  failing = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = {
    user_wallets: [wallet()],
    prompts: [{ id: "p1", price_usd_cents: 150, creator_id: ARTIST, prompt_type: "paid", is_free_showcase: false, is_listed: true, listing_status: "active", deleted_at: null }],
  };
});

describe("an artist's payout wallet", () => {
  it("is their live Solana wallet", async () => {
    expect(await artistPayoutWallet(fake, ARTIST)).toEqual({ ok: true, wallet: SOLANA });
  });

  it("is never someone else's", async () => {
    db.user_wallets = [wallet({ user_id: "someone-else" })];
    expect(await artistPayoutWallet(fake, ARTIST)).toMatchObject({ ok: false, status: 422 });
  });

  it("is no wallet of another chain", async () => {
    db.user_wallets = [wallet({ chain_family: "evm", address: "0xAbC0000000000000000000000000000000000001" })];
    expect(await artistPayoutWallet(fake, ARTIST)).toMatchObject({ ok: false, status: 422 });
  });

  it("is no wallet they removed", async () => {
    db.user_wallets = [wallet({ removed_at: "2026-09-01T00:00:00Z" })];
    expect(await artistPayoutWallet(fake, ARTIST)).toMatchObject({ ok: false, status: 422 });
  });

  it("is no placeholder left by the old login", async () => {
    db.user_wallets = [wallet({ address: "legacy-unbound" })];
    expect(await artistPayoutWallet(fake, ARTIST)).toEqual({ ok: false, status: 422, error: "Artist payout wallet not configured for this prompt" });
  });

  it("is no address an old bug lowercased, which decodes to a key nobody holds", async () => {
    db.user_wallets = [wallet({ address: SOLANA.toLowerCase() })];
    expect(await artistPayoutWallet(fake, ARTIST)).toEqual({ ok: false, status: 422, error: "Artist payout wallet must be re-linked before this prompt can sell" });
  });

  it("is unknown, not missing, while the lookup fails", async () => {
    failing = "user_wallets";
    expect(await artistPayoutWallet(fake, ARTIST)).toEqual({ ok: false, status: 500, error: "Failed to load creator" });
  });
});

describe("the quote of a paid prompt", () => {
  const quote = () => computeQuote(fake, { promptId: "p1", modelFamily: "nano-banana-pro", resolution: "2K" });

  it("pays the artist's share to that wallet", async () => {
    expect(await quote()).toMatchObject({ ok: true, artistWallet: SOLANA });
  });

  it("is refused with the wallet's own reason", async () => {
    db.user_wallets = [];
    expect(await quote()).toEqual({ ok: false, status: 422, error: "Artist payout wallet not configured for this prompt" });
    db.user_wallets = [wallet({ address: SOLANA.toLowerCase() })];
    expect(await quote()).toEqual({ ok: false, status: 422, error: "Artist payout wallet must be re-linked before this prompt can sell" });
    failing = "user_wallets";
    expect(await quote()).toEqual({ ok: false, status: 500, error: "Failed to load creator" });
  });

  it("asks for no wallet when the prompt is free", async () => {
    db.prompts[0].prompt_type = "free";
    db.user_wallets = [];
    expect(await quote()).toMatchObject({ ok: true, artistWallet: null });
  });
});
