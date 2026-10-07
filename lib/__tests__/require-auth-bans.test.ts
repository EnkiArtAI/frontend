import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * requireAuth guards the whole paid rail (quote, intent, authorize, submit,
 * generate-image). It read the session row alone, so a ban stopped the feed
 * and the editor but not a purchase or a generation (Kev, 2026-10-06).
 */

const UUID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const WALLET = "So1anaWa11etAddressWithMixedCase11111111111";
const DEAD_HOST = { message: "TypeError: fetch failed", details: "getaddrinfo ENOTFOUND x.supabase.co", hint: "", code: "" };

let tables: Record<string, { data: unknown; error: unknown }> = {};
const from = vi.fn((table: string) => {
  const result = tables[table] ?? { data: null, error: null };
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gt", "is", "or", "order", "limit"]) c[m] = () => c;
  c.maybeSingle = () => Promise.resolve(result);
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return c;
});
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from }) }));

const { requireAuth } = await import("@/lib/auth");
const request = (token?: string) =>
  ({ headers: new Headers(token ? { "X-Session-Token": token } : {}) }) as unknown as NextRequest;
const BAN = { data: [{ id: 7, reason: "Automated: warnings, step 1", expires_at: null }], error: null };

beforeEach(() => { tables = {}; from.mockClear(); });

describe("requireAuth", () => {
  it("refuses a banned email session", async () => {
    tables = { auth_sessions: { data: { wallet_address: UUID }, error: null }, bans: BAN };
    await expect(requireAuth(request("tok"))).rejects.toThrow(/session token is required/);
  });

  it("refuses a banned wallet session", async () => {
    tables = {
      auth_sessions: { data: { wallet_address: WALLET }, error: null },
      user_wallets: { data: { user_id: UUID }, error: null },
      bans: BAN,
    };
    await expect(requireAuth(request("tok"))).rejects.toThrow(/session token is required/);
  });

  it("passes an unbanned session through as the stored wallet value", async () => {
    tables = {
      auth_sessions: { data: { wallet_address: WALLET }, error: null },
      user_wallets: { data: { user_id: UUID }, error: null },
      bans: { data: [], error: null },
    };
    await expect(requireAuth(request("tok"))).resolves.toEqual({ walletAddress: WALLET, userId: WALLET });
  });

  it("still passes a wallet session with no account behind it, as before", async () => {
    tables = { auth_sessions: { data: { wallet_address: WALLET }, error: null } };
    await expect(requireAuth(request("tok"))).resolves.toEqual({ walletAddress: WALLET, userId: WALLET });
  });

  it("refuses when the database cannot be reached", async () => {
    tables = { auth_sessions: { data: null, error: DEAD_HOST } };
    await expect(requireAuth(request("tok"))).rejects.toThrow(/session token is required/);
  });

  it("refuses without a token and never queries", async () => {
    await expect(requireAuth(request())).rejects.toThrow(/session token is required/);
    expect(from).not.toHaveBeenCalled();
  });
});
