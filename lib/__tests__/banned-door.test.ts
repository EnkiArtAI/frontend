import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { readSource } from "@/lib/__tests__/_read-source";
import { APP_NAME } from "@/shared/app-config";

/**
 * BAN-1. A banned account keeps one door: /banned and the APIs it calls. The
 * team cookie opens every page, so a banned login never gets it, and the
 * door works without it.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const kp = Keypair.generate();
const ADDRESS = kp.publicKey.toBase58();

let banned = false;
vi.mock("@/lib/session-user", () => ({
  activeBanFor: async () => (banned ? { id: "b1", reason: "spam", expiresAt: null } : null),
}));
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
  const result = { data: rows[table] ?? null, error: null };
  const c: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok),
  };
  for (const m of ["select", "insert", "update", "eq", "ilike", "is", "single", "maybeSingle"]) c[m] = () => c;
  return c;
};
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({ from: chain, rpc: async () => ({ data: true, error: null }) }),
}));

process.env.TEAM_ACCESS_CODE = "team-code";
import { proxy } from "../../proxy";
import { POST as passwordLogin } from "../../app/api/auth/password/login/route";
import { POST as walletLogin } from "../../app/api/auth/session/route";

const teamCookie = (res: Response) => (res.headers.get("set-cookie") ?? "").includes("enki_team=");

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
  it("gets no team cookie by password, and is routed to /banned", async () => {
    banned = true;
    const res = await viaPassword();
    expect(res.status).toBe(200);
    expect((await res.json()).banned).toBe(true);
    expect(teamCookie(res)).toBe(false);
  });

  it("gets no team cookie by wallet signature", async () => {
    banned = true;
    const res = await viaWallet();
    expect(res.status).toBe(200);
    expect((await res.json()).banned).toBe(true);
    expect(teamCookie(res)).toBe(false);
  });

  it("while an account in good standing still gets it both ways", async () => {
    expect(teamCookie(await viaPassword())).toBe(true);
    expect(teamCookie(await viaWallet())).toBe(true);
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
