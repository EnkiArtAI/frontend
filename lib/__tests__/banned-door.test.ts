import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { readSource } from "@/lib/__tests__/_read-source";
import { APP_NAME } from "@/shared/app-config";

/**
 * BAN-1. A banned account keeps one door: /banned and the APIs it calls. The
 * team cookie opens every page, so a banned account loses it wherever it
 * shows up (login, /banned, the shell's identity check), gets it back once
 * the ban ends, and the door works without it.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const kp = Keypair.generate();
const ADDRESS = kp.publicKey.toBase58();

let banned = false;
const BAN = { id: "b1", reason: "spam", expiresAt: null };
vi.mock("@/lib/session-user", () => ({
  activeBanFor: async () => (banned ? BAN : null),
  resolveSessionUserWithBan: async () => ({ userId: USER, wallet: USER, ban: banned ? BAN : null }),
  resolveSessionUserId: async () => (banned ? null : USER),
}));
const rpcReads = vi.fn(async () => 1.5);
vi.mock("@/lib/usdc-balance", () => ({ getUsdcBalance: () => rpcReads() }));
vi.mock("@/lib/password-auth", () => ({ verifyOrDecoy: () => true }));
vi.mock("@/lib/user-session", () => ({ mintUserSession: async () => ({ token: "tok", expiresAt: "2026-10-08T00:00:00Z" }) }));
vi.mock("@/lib/ip-hash", () => ({ getClientIp: () => "203.0.113.9", hashIp: () => "iphash", isIpBanned: async () => false }));
vi.mock("@/lib/allowlist", async (orig) => ({ ...(await orig<typeof import("@/lib/allowlist")>()), whitelistStageActive: () => false }));

// Every query answers by table; awaiting any step of the chain resolves it.
const rows: Record<string, unknown> = {
  password_credentials: { user_id: USER, email: "a@enki.test", pw_hash: "h", pw_salt: "s" },
  user_wallets: { user_id: USER, address: ADDRESS },
};
const chain = (table: string): unknown => {
  let one = false;
  const row = rows[table] ?? null;
  const c: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: one ? row : row ? [row] : [], error: null }).then(ok),
  };
  for (const m of ["select", "insert", "update", "eq", "ilike", "is", "order", "limit"]) c[m] = () => c;
  for (const m of ["single", "maybeSingle"]) c[m] = () => { one = true; return c; };
  return c;
};
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({ from: chain, rpc: async () => ({ data: true, error: null }) }),
}));

process.env.TEAM_ACCESS_CODE = "team-code";
import { proxy } from "../../proxy";
import { POST as passwordLogin } from "../../app/api/auth/password/login/route";
import { POST as walletLogin } from "../../app/api/auth/session/route";
import { GET as banMe } from "../../app/api/ban/me/route";
import { GET as identity } from "../../app/api/users/handle/route";
import { GET as balance } from "../../app/api/billing/balance/route";

const cookie = (res: Response) => res.headers.get("set-cookie") ?? "";
const teamCookie = (res: Response) => cookie(res).includes("enki_team=team-code");
const revoked = (res: Response) => /enki_team=;.*Max-Age=0/i.test(cookie(res));
const withSession = (path: string) => new NextRequest(`http://enki.test${path}`, { headers: { "X-Session-Token": "tok" } });

const viaPassword = () =>
  passwordLogin(new NextRequest("http://enki.test/api/auth/password/login", {
    method: "POST", body: JSON.stringify({ identifier: "a@enki.test", password: "pw" }),
  }));

const viaWallet = () => {
  const nonce = Math.random().toString(36).slice(2);
  const message = `${APP_NAME} sign in\n${ADDRESS}\nnonce ${nonce}`;
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32))).toString("base64");
  return walletLogin(new NextRequest("http://enki.test/api/auth/session", {
    method: "POST",
    body: JSON.stringify({ walletAddress: ADDRESS, walletType: "solana", signature, message, timestamp: Date.now(), nonce }),
  }));
};

beforeEach(() => { banned = false; });

describe("a banned login", () => {
  it("loses the team cookie by password, and is routed to /banned", async () => {
    banned = true;
    const res = await viaPassword();
    expect(res.status).toBe(200);
    expect((await res.json()).banned).toBe(true);
    expect(teamCookie(res)).toBe(false);
    expect(revoked(res)).toBe(true);
  });

  it("loses the team cookie by wallet signature", async () => {
    banned = true;
    const res = await viaWallet();
    expect(res.status).toBe(200);
    expect((await res.json()).banned).toBe(true);
    expect(teamCookie(res)).toBe(false);
    expect(revoked(res)).toBe(true);
  });

  it("while an account in good standing still gets it both ways", async () => {
    expect(teamCookie(await viaPassword())).toBe(true);
    expect(teamCookie(await viaWallet())).toBe(true);
  });
});

describe("a session that was banned after it got the cookie", () => {
  it("is told so by the shell's identity check, which takes the cookie back", async () => {
    banned = true;
    const res = await identity(withSession("/api/users/handle"));
    expect(res.status).toBe(403);
    expect((await res.json()).banned).toBe(true);
    expect(revoked(res)).toBe(true);
  });

  it("loses the cookie on /banned too", async () => {
    banned = true;
    const res = await banMe(withSession("/api/ban/me"));
    expect((await res.json()).banned).toBe(true);
    expect(revoked(res)).toBe(true);
  });

  it("gets the cookie back on /banned once the ban ended", async () => {
    const res = await banMe(withSession("/api/ban/me"));
    expect((await res.json()).banned).toBe(false);
    expect(teamCookie(res)).toBe(true);
  });

  it("is sent to /banned by the client wall", () => {
    const gate = readSource("components/BetaGate.tsx");
    expect(gate).toMatch(/if \(res\.status === 403 && \(await res\.json\(\)\.catch\(\(\) => null\)\)\?\.banned\) \{\n\s+if \(window\.location\.pathname !== "\/banned"\) window\.location\.href = "\/banned";/);
  });
});

describe("the public balance", () => {
  it("answers, but bounds how often one network may make us ask the chain", async () => {
    rpcReads.mockClear();
    const ask = () => balance(new NextRequest("http://enki.test/api/billing/balance?address=So11111111111111111111111111111111111111112", { headers: { "x-forwarded-for": "198.51.100.7" } }));
    expect(await (await ask()).json()).toEqual({ balance: 1.5 });
    for (let i = 1; i < 30; i++) await ask();
    expect((await ask()).status).toBe(429);
    expect(rpcReads).toHaveBeenCalledTimes(30);
  });
});

describe("the door works without the cookie", () => {
  const visit = (path: string) => proxy(new NextRequest(`http://enki.test${path}`));
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("lets /banned and exactly its APIs through", () => {
    for (const p of ["/banned", "/api/ban/me", "/api/ban/appeal", "/api/billing/balance", "/api/wallet/withdraw/build", "/api/wallet/withdraw/submit"]) {
      expect(passes(visit(p)), p).toBe(true);
    }
  });

  it("keeps the rest of the app walled", () => {
    expect(visit("/settings").headers.get("location")).toContain("/gate");
    expect(visit("/api/prompts").status).toBe(401);
    expect(visit("/api/ban/council").status).toBe(401);
  });

  it("renders /banned for a session the client wall would turn away", () => {
    const src = readSource("components/BetaGate.tsx");
    const publicPaths = src.match(/const PUBLIC_PATHS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
    expect(publicPaths).toContain('"/banned"');
  });
});
