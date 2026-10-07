import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * BAN-2. /banned offers Send and key export for the embedded wallet and the
 * "open it in Phantom" text for a self-custodial one. Both are stored as
 * external_eoa, so GET /api/ban/me tells them apart by how the account signs
 * in; before, every wallet read as external and the embedded door never
 * showed.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const ADDRESS = "So11111111111111111111111111111111111111112";

vi.mock("@/lib/session-user", () => ({
  resolveSessionUserWithBan: async () => ({ userId: USER, wallet: ADDRESS, ban: { id: "b1", reason: "spam", expiresAt: null } }),
}));

let sessionType = "password";
const rows = (table: string) =>
  table === "auth_sessions" ? { wallet_type: sessionType }
  : table === "user_wallets" ? [{ address: ADDRESS, wallet_type: "external_eoa", chain_family: "solana" }]
  : [];
const chain = (table: string): unknown => {
  const c: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(table), error: null }).then(ok),
  };
  for (const m of ["select", "eq", "is", "order", "limit", "maybeSingle"]) c[m] = () => c;
  return c;
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: chain }) }));

import { GET } from "../../app/api/ban/me/route";

const wallets = async () => {
  const res = await GET(new NextRequest("http://enki.test/api/ban/me", { headers: { "X-Session-Token": "tok" } }));
  return (await res.json()).wallets as { address: string; external: boolean }[];
};

beforeEach(() => { sessionType = "password"; });

describe("a banned account's wallets", () => {
  it("are embedded for an account that signs in with a password", async () => {
    expect(await wallets()).toEqual([{ address: ADDRESS, external: false, chain: "solana" }]);
  });

  it.each(["solana", "evm"])("are self-custodial for an account that signs in with its %s wallet", async (type) => {
    sessionType = type;
    expect((await wallets())[0].external).toBe(true);
  });
});
