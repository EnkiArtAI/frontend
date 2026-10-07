import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * attach-wallet points a password session at a Solana address, and every
 * resolver then maps that address to users.id through user_wallets. An
 * address another account owns must therefore be refused: accepting it makes
 * the caller that account, and /api/auth/wallet/jwt then mints a CDP login
 * (sub = users.id) for that account's embedded wallet.
 *
 * The fake applies filters the way PostgREST does and enforces NO unique index
 * on user_wallets.address, because the live constraint is unverified and the
 * route must not depend on one.
 */

type Row = Record<string, unknown>;
type Result = { data: unknown; error: unknown; count?: number };

let db: Record<string, Row[]>;
let failNext: { table: string; op: "select" | "insert" } | null;

class Query implements PromiseLike<Result> {
  private filters: ((r: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private single = false;
  private counting = false;
  private cap = Infinity;

  constructor(private table: string) {}

  select(_cols?: string, opts?: { head?: boolean }) { this.counting = Boolean(opts?.head); return this; }
  update(patch: Row) { this.patch = patch; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); return this; }
  gt(col: string, v: string) { this.filters.push((r) => String(r[col]) > v); return this; }
  is(col: string, v: null) { this.filters.push((r) => (r[col] ?? null) === v); return this; }
  not(col: string, _op: "is", v: null) { this.filters.push((r) => (r[col] ?? null) !== v); return this; }
  ilike(col: string, pattern: string) {
    if (/[%_]/.test(pattern)) throw new Error("fake: ilike wildcards unsupported");
    this.filters.push((r) => String(r[col]).toLowerCase() === pattern.toLowerCase());
    return this;
  }
  // Only activeBanFor uses these, and only against an empty bans table.
  or() { return this.emptyOnly("or"); }
  order() { return this.emptyOnly("order"); }
  limit(n: number) { this.cap = n; return this; }
  maybeSingle() { this.single = true; return this; }

  insert(row: Row): Promise<Result> {
    if (this.fails("insert")) return Promise.resolve({ data: null, error: { message: "fake insert failure" } });
    db[this.table].push({ ...row });
    return Promise.resolve({ data: null, error: null });
  }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, ko);
  }

  private run(): Result {
    if (!this.patch && this.fails("select")) return { data: null, error: { message: "fake lookup failure" } };
    const hits = db[this.table].filter((r) => this.filters.every((f) => f(r))).slice(0, this.cap);
    if (this.patch) {
      hits.forEach((r) => Object.assign(r, this.patch));
      return { data: null, error: null };
    }
    if (this.counting) return { data: null, count: hits.length, error: null };
    if (!this.single) return { data: hits.map((r) => ({ ...r })), error: null };
    if (hits.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
    return { data: hits[0] ? { ...hits[0] } : null, error: null };
  }

  private fails(op: "select" | "insert") {
    if (failNext?.table !== this.table || failNext.op !== op) return false;
    failNext = null;
    return true;
  }

  private emptyOnly(op: string) {
    if (db[this.table].length) throw new Error(`fake: ${op}() is only modelled on empty tables`);
    return this;
  }
}

const fake = {
  from(table: string) {
    if (!db[table]) throw new Error(`fake: unknown table ${table}`);
    return new Query(table);
  },
};

vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => fake }));
vi.mock("@/lib/wallet-jwt", () => ({ mintWalletJwt: async (u: { id: string }) => `jwt:${u.id}` }));

import { POST as attachWallet } from "../../app/api/auth/session/attach-wallet/route";
import { POST as mintJwt } from "../../app/api/auth/wallet/jwt/route";
import { resolveSessionUserWithBan } from "@/lib/session-user";

const ATTACKER = "aaaaaaaa-0000-4000-8000-000000000001";
const VICTIM = "bbbbbbbb-0000-4000-8000-000000000002";
const TOKEN = "attacker-session-token";
const solana = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const ATTACKER_SOL = solana(7);
const VICTIM_SOL = solana(9);
const VICTIM_EVM = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

function passwordSession(token: string, userId: string): Row {
  return { token, wallet_address: userId, wallet_type: "password", expires_at: FUTURE };
}

beforeEach(() => {
  failNext = null;
  db = {
    auth_sessions: [passwordSession(TOKEN, ATTACKER)],
    user_wallets: [
      { user_id: VICTIM, address: VICTIM_SOL, chain_family: "solana", removed_at: null },
      // The wallet login stores EVM addresses lowercased.
      { user_id: VICTIM, address: VICTIM_EVM.toLowerCase(), chain_family: "evm", removed_at: null },
    ],
    password_credentials: [
      { user_id: ATTACKER, email: "attacker@example.test" },
      { user_id: VICTIM, email: "victim@example.test" },
    ],
    users: [{ id: ATTACKER, handle: null }, { id: VICTIM, handle: null }],
    bans: [],
    // Read by the wallet JWT once the account's second factors gate it (MFA stack).
    mfa_factors: [],
    webauthn_credentials: [],
  };
});

async function attach(body: object, token = TOKEN) {
  const res = await attachWallet(new NextRequest("http://localhost/api/auth/session/attach-wallet", {
    method: "POST",
    headers: { "X-Session-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return res.status;
}

const sessionAddress = (token = TOKEN) => db.auth_sessions.find((s) => s.token === token)!.wallet_address;
const resolvedUser = async (token = TOKEN) => (await resolveSessionUserWithBan(fake as unknown as SupabaseClient, token)).userId;

async function walletJwtSubject(token = TOKEN) {
  const res = await mintJwt(new NextRequest("http://localhost/api/auth/wallet/jwt", {
    method: "POST",
    headers: { "X-Session-Token": token },
  }));
  return (await res.json()).userId;
}

describe("attach-wallet cannot hand the caller another account", () => {
  it("refuses an address another account owns, and the caller stays the caller", async () => {
    expect.soft(await attach({ solanaAddress: VICTIM_SOL })).toBe(409);
    expect.soft(sessionAddress()).toBe(ATTACKER);
    expect.soft(await resolvedUser()).toBe(ATTACKER);
    expect.soft(await walletJwtSubject()).toBe(ATTACKER);
  });

  it("treats a case variant of an owned address as owned", async () => {
    expect(await attach({ solanaAddress: ATTACKER_SOL, evmAddress: VICTIM_EVM })).toBe(409);
    expect(sessionAddress()).toBe(ATTACKER);
    const squatted = db.user_wallets.filter(
      (w) => w.user_id === ATTACKER && String(w.address).toLowerCase() === VICTIM_EVM.toLowerCase(),
    );
    expect(squatted).toEqual([]);
  });

  it("writes no wallet row for a refused attach", async () => {
    // The foreign EVM address is the second row: the caller's own Solana row must not be written first.
    expect(await attach({ solanaAddress: ATTACKER_SOL, evmAddress: VICTIM_EVM })).toBe(409);
    expect(db.user_wallets.filter((w) => w.user_id === ATTACKER)).toEqual([]);
  });

  it("refuses when the ownership lookup fails", async () => {
    failNext = { table: "user_wallets", op: "select" };
    expect(await attach({ solanaAddress: VICTIM_SOL })).toBe(500);
    expect(sessionAddress()).toBe(ATTACKER);
  });

  it("refuses when the wallet row cannot be written", async () => {
    failNext = { table: "user_wallets", op: "insert" };
    expect(await attach({ solanaAddress: ATTACKER_SOL })).toBe(500);
    expect(sessionAddress()).toBe(ATTACKER);
  });

  it("still attaches a fresh address and re-attaches the caller's own", async () => {
    expect(await attach({ solanaAddress: ATTACKER_SOL })).toBe(200);
    expect(await resolvedUser()).toBe(ATTACKER);

    // Next login: a fresh session on the users.id bridge, the row already exists.
    db.auth_sessions.push(passwordSession("second-login", ATTACKER));
    expect(await attach({ solanaAddress: ATTACKER_SOL }, "second-login")).toBe(200);
    expect(await resolvedUser("second-login")).toBe(ATTACKER);
    expect(db.user_wallets.filter((w) => w.address === ATTACKER_SOL)).toHaveLength(1);
  });
});
