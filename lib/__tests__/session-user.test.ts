import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSessionUserWithBan, resolveSessionUserId } from "@/lib/session-user";
import { DbUnreachableError } from "@/lib/db-error";

const DEAD_HOST = { message: "TypeError: fetch failed", details: "Caused by: Error: getaddrinfo ENOTFOUND x.supabase.co", hint: "", code: "" };
const UUID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";

/** A postgrest-shaped builder: every filter returns itself, awaiting it (or
    .maybeSingle()) yields the canned result for that table. */
function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gt", "is", "or", "order", "limit"]) c[m] = () => c;
  c.maybeSingle = () => Promise.resolve(result);
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return c;
}
function fakeSupabase(byTable: Record<string, { data: unknown; error: unknown }>) {
  const from = vi.fn((table: string) => chain(byTable[table] ?? { data: null, error: null }));
  return { client: { from } as unknown as SupabaseClient, from };
}

describe("resolveSessionUserWithBan", () => {
  it("throws the unreachable marker when the session lookup never reached the host", async () => {
    const { client } = fakeSupabase({ auth_sessions: { data: null, error: DEAD_HOST } });
    await expect(resolveSessionUserWithBan(client, "tok")).rejects.toBeInstanceOf(DbUnreachableError);
  });

  it("still answers 'nobody' for an unknown or expired token (no error, no row)", async () => {
    const { client } = fakeSupabase({ auth_sessions: { data: null, error: null } });
    await expect(resolveSessionUserWithBan(client, "tok")).resolves.toEqual({ userId: null, ban: null });
  });

  it("resolves a uuid session and an empty ban list to the user", async () => {
    const { client } = fakeSupabase({ auth_sessions: { data: { wallet_address: UUID }, error: null }, bans: { data: [], error: null } });
    await expect(resolveSessionUserId(client, "tok")).resolves.toBe(UUID);
  });

  it("throws when the wallet→user or ban lookups hit a dead host", async () => {
    const viaWallet = fakeSupabase({ auth_sessions: { data: { wallet_address: "So1anaAddr" }, error: null }, user_wallets: { data: null, error: DEAD_HOST } });
    await expect(resolveSessionUserWithBan(viaWallet.client, "tok")).rejects.toBeInstanceOf(DbUnreachableError);
    const viaBans = fakeSupabase({ auth_sessions: { data: { wallet_address: UUID }, error: null }, bans: { data: null, error: DEAD_HOST } });
    await expect(resolveSessionUserWithBan(viaBans.client, "tok")).rejects.toBeInstanceOf(DbUnreachableError);
  });

  it("does not misread an ordinary query error as an outage", async () => {
    const { client } = fakeSupabase({ auth_sessions: { data: null, error: { message: "permission denied for table auth_sessions", code: "42501" } } });
    await expect(resolveSessionUserWithBan(client, "tok")).resolves.toEqual({ userId: null, ban: null });
  });

  it("never queries without a token", async () => {
    const { client, from } = fakeSupabase({});
    await expect(resolveSessionUserWithBan(client, null)).resolves.toEqual({ userId: null, ban: null });
    expect(from).not.toHaveBeenCalled();
  });
});
