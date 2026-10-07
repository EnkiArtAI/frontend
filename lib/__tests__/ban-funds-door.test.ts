import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import type { NextRequest } from "next/server";
import { DbUnreachableError } from "@/lib/db-error";

/**
 * BAN-6. A ban locks the marketplace, never the wallet. requireAuth refuses a
 * banned session; the routes that read auth_sessions themselves need their own
 * answer: the ramp (both ways) and mapping new wallets close, and the wallet
 * JWT stays ban tolerant so a suspended account still signs its sends and
 * exports its key on /banned.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const SOL = "So11111111111111111111111111111111111111112"; // real base58 casing, as stored since 2d08fe7

let banned = false;
let dbDown = false; // the whole database
let tablesDown = false; // only the queries a route runs itself
let session: { userId: string | null; wallet: string | null } = { userId: USER, wallet: SOL };
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserWithBan: async () => {
    if (dbDown) throw new DbUnreachableError();
    return { ...session, ban: banned ? { id: "b1", reason: "spam", expiresAt: null } : null };
  },
  activeBanFor: async () => {
    if (dbDown) throw new DbUnreachableError();
    return banned ? { id: "b1", reason: "spam", expiresAt: null } : null;
  },
}));

const writes: string[] = [];
const DEAD = { message: "TypeError: fetch failed" };
let ownedRows: { address: string }[] = [];
let ownedQuery: unknown[] = [];
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        gt: () => chain,
        in: (_col: string, values: unknown[]) => { ownedQuery = values; return chain; },
        limit: async () => (dbDown || tablesDown ? { data: null, error: DEAD } : { data: ownedRows, error: null }),
        maybeSingle: async () =>
          dbDown || tablesDown ? { data: null, error: DEAD }
          : table === "auth_sessions" ? { data: { wallet_address: USER, wallet_type: "password" }, error: null }
          : { data: null, error: null },
        insert: async () => { writes.push(`${table}.insert`); return { error: null }; },
        update: () => ({ eq: async () => { writes.push(`${table}.update`); return { error: null }; } }),
      };
      return chain;
    },
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
  dbDown = false;
  tablesDown = false;
  session = { userId: USER, wallet: SOL };
  ownedRows = [];
  ownedQuery = [];
  writes.length = 0;
  coinbase.mockClear();
  vi.stubGlobal("fetch", coinbase);
  vi.stubEnv("CDP_API_KEY_ID", "id");
  vi.stubEnv("CDP_SECRET_KEY", "secret");
  vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("the ramp", () => {
  it("opens for the session's own wallet in its real casing", async () => {
    const res = await ramp(post({ side: "buy", address: SOL }));
    expect(res.status).toBe(200);
    expect(coinbase).toHaveBeenCalledTimes(1);
  });

  it("opens for a wallet the account owns, in either stored casing", async () => {
    session = { userId: USER, wallet: USER }; // an email session, still on the bridge
    ownedRows = [{ address: SOL }];
    const res = await ramp(post({ side: "buy", address: SOL }));
    expect(res.status).toBe(200);
    expect(ownedQuery).toEqual([SOL, SOL.toLowerCase()]);
  });

  it("refuses a wallet the account does not own", async () => {
    session = { userId: USER, wallet: USER };
    const res = await ramp(post({ side: "buy", address: SOL }));
    expect(res.status).toBe(403);
    expect(coinbase).not.toHaveBeenCalled();
  });

  it("answers an expired or unknown session as signed out", async () => {
    session = { userId: null, wallet: null };
    const res = await ramp(post({ side: "buy", address: SOL }));
    expect(res.status).toBe(401);
    expect(coinbase).not.toHaveBeenCalled();
  });

  it("closes buying and selling for a suspended account, before Coinbase is asked", async () => {
    banned = true;
    for (const side of ["buy", "sell"]) {
      const res = await ramp(post({ side, address: SOL }));
      expect(res.status, side).toBe(403);
      expect(await res.json()).toMatchObject({ banned: true });
    }
    expect(coinbase).not.toHaveBeenCalled();
  });

  it("answers a dead database with the honest 503", async () => {
    dbDown = true;
    expect((await ramp(post({ side: "buy", address: SOL }))).status).toBe(503);
  });

  it("answers a database that dies at the ownership lookup with 503, not 'not yours'", async () => {
    session = { userId: USER, wallet: USER };
    tablesDown = true;
    expect((await ramp(post({ side: "buy", address: SOL }))).status).toBe(503);
  });
});

describe("the ramp on a devnet deployment", () => {
  beforeEach(() => vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet"));

  it("opens Coinbase's sandbox for buying: the whole flow, no card charged", async () => {
    const res = await ramp(post({ side: "buy", address: SOL }));
    expect(res.status).toBe(200);
    expect(new URL((await res.json()).url).host).toBe("pay-sandbox.coinbase.com");
  });

  it("refuses selling before Coinbase is asked: it has no sandbox", async () => {
    const res = await ramp(post({ side: "sell", address: SOL }));
    expect(res.status).toBe(501);
    expect(coinbase).not.toHaveBeenCalled();
  });

  it("on mainnet both sides open the real Coinbase", async () => {
    vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana");
    for (const side of ["buy", "sell"]) {
      const res = await ramp(post({ side, address: SOL }));
      expect(new URL((await res.json()).url).host, side).toBe("pay.coinbase.com");
    }
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

  it("answers a dead database with the honest 503 and maps nothing, at the session lookup too", async () => {
    tablesDown = true;
    expect((await attach(post({ solanaAddress: SOL }))).status).toBe(503);
    tablesDown = false;
    dbDown = true;
    const res = await attach(post({ solanaAddress: SOL }));
    expect(res.status).toBe(503);
    expect(writes).toEqual([]);
  });
});

describe("the wallet JWT stays open", () => {
  it("reads no ban in any form, so a suspended account still signs and exports", () => {
    const jwt = readSource(join(__dirname, "..", "..", "app", "api", "auth", "wallet", "jwt", "route.ts"));
    expect(jwt).toMatch(/mintWalletJwt\(/);
    expect(jwt).not.toMatch(/activeBanFor|resolveSessionUser|resolveOwnerIds|requireAuth|\bban\b|bans/);
  });
});
