import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import type { NextRequest } from "next/server";

/**
 * BAN-6. A ban locks the marketplace, never the wallet. requireAuth refuses a
 * banned session; the routes that read auth_sessions themselves need their own
 * answer: the ramp and attach-wallet close, the wallet JWT stays open so a
 * suspended account still signs its sends and its key export on /banned.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const SOL = "So11111111111111111111111111111111111111112";
const BAN = { id: "b1", reason: "spam", expiresAt: null };

let banned = false;
let signedIn = true;
const resolve = vi.fn(async () =>
  signedIn ? { userId: USER, ban: banned ? BAN : null, wallet: SOL.toLowerCase() } : { userId: null, ban: null, wallet: null },
);
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserWithBan: () => resolve(),
  activeBanFor: async () => (banned ? BAN : null),
}));

const writes: string[] = [];
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          gt: () => ({ maybeSingle: async () => ({ data: { wallet_address: USER, wallet_type: "password" } }) }),
          maybeSingle: async () => ({ data: null }),
        }),
      }),
      insert: async () => { writes.push(`${table}.insert`); return { error: null }; },
      update: () => ({ eq: async () => { writes.push(`${table}.update`); return { error: null }; } }),
    }),
  }),
}));
vi.mock("@coinbase/cdp-sdk/auth", () => ({ generateJwt: async () => "jwt" }));

import { POST as ramp } from "../../app/api/onramp/session/route";
import { POST as attach } from "../../app/api/auth/session/attach-wallet/route";

const post = (body: unknown) =>
  new Request("http://x", { method: "POST", headers: { "X-Session-Token": "tok", "Content-Type": "application/json" }, body: JSON.stringify(body) }) as unknown as NextRequest;

const coinbase = vi.fn(async () => Response.json({ token: "session-token" }));
beforeEach(() => {
  banned = false;
  signedIn = true;
  writes.length = 0;
  coinbase.mockClear();
  vi.stubGlobal("fetch", coinbase);
  vi.stubEnv("CDP_API_KEY_ID", "id");
  vi.stubEnv("CDP_SECRET_KEY", "secret");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("the ramp", () => {
  it("opens for an account in good standing", async () => {
    const res = await ramp(post({ side: "sell", address: SOL }));
    expect(res.status).toBe(200);
    expect(coinbase).toHaveBeenCalledTimes(1);
  });

  it("answers an expired or unknown session as signed out", async () => {
    signedIn = false;
    const res = await ramp(post({ side: "buy", address: SOL }));
    expect(res.status).toBe(401);
    expect(coinbase).not.toHaveBeenCalled();
  });

  it("closes for a suspended account, before Coinbase is asked", async () => {
    banned = true;
    for (const side of ["buy", "sell"]) {
      const res = await ramp(post({ side, address: SOL }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ banned: true });
    }
    expect(coinbase).not.toHaveBeenCalled();
  });
});

describe("attach-wallet", () => {
  it("maps a wallet for an account in good standing", async () => {
    const res = await attach(post({ solanaAddress: SOL }));
    expect(res.status).toBe(200);
    expect(writes).toEqual(["user_wallets.insert", "auth_sessions.update"]);
  });

  it("maps nothing for a suspended account", async () => {
    banned = true;
    const res = await attach(post({ solanaAddress: SOL }));
    expect(res.status).toBe(403);
    expect(writes).toEqual([]);
  });
});

describe("the funds door stays open", () => {
  it("the wallet JWT reads no ban, so a suspended account still signs", () => {
    const jwt = readSource(join(__dirname, "..", "..", "app", "api", "auth", "wallet", "jwt", "route.ts"));
    expect(jwt).toMatch(/mintWalletJwt\(/);
    expect(jwt).not.toMatch(/activeBanFor|resolveSessionUserId|requireAuth|\.ban\b/);
  });
});
