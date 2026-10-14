import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { APP_NAME } from "@/shared/app-config";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";

/**
 * During the whitelist stage, an account that comes in through the access
 * list is a beta member (Kev, 2026-10-13). A listed wallet's first login used
 * to create its account at the column default 'user'; the client wall admits
 * beta/mod/admin only, so the owner could log in and pick a name and was then
 * shown "Log in to generate", with no balance and no log out.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
const ban = vi.hoisted(() => ({ active: false }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.mock("@/lib/session-user", () => ({ activeBanFor: async () => (ban.active ? { id: "ban" } : null) }));
vi.mock("@/lib/ip-hash", () => ({ getClientIp: () => "203.0.113.9", hashIp: () => "iphash", isIpBanned: async () => false }));
vi.mock("@/lib/user-session", () => ({ mintUserSession: async () => ({ token: "t", expiresAt: "2026-10-14T00:00:00.000Z" }) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRequestRateLimit: () => ({ allowed: true }), rateLimitKey: () => "k", rateLimitResponse: () => new Response(null, { status: 429 }),
}));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64"); });

import { POST as walletLogin } from "../../app/api/auth/session/route";
import { POST as register } from "../../app/api/auth/password/register/route";
import { openLoginSession } from "@/lib/password-login";
import { admitAllowlisted } from "@/lib/allowlist";

// The register test hashes a password with Argon2id (64 MiB, 3 passes).
vi.setConfig({ testTimeout: 60_000 });

const kp = Keypair.generate();
const ADDRESS = kp.publicKey.toBase58();
const FUTURE = "2099-01-01T00:00:00.000Z";
const tables = () => db.current!.tables;
const roleOf = (id: string) => tables().users.find((u) => u.id === id)?.role;

async function login() {
  const nonce = `n${tables().auth_nonces.length}`;
  tables().auth_nonces.push({ wallet_address: ADDRESS.toLowerCase(), nonce, consumed: false, expires_at: FUTURE });
  const message = `${APP_NAME} sign in\n${ADDRESS}\nnonce ${nonce}`;
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32))).toString("base64");
  return walletLogin(new NextRequest("http://enki.test/api/auth/session", {
    method: "POST",
    body: JSON.stringify({ walletAddress: ADDRESS, walletType: "solana", signature, message, timestamp: Date.now(), nonce }),
  }));
}
const account = (role: string) => {
  tables().users.push({ id: "u1", role });
  tables().user_wallets.push({ user_id: "u1", address: ADDRESS, removed_at: null });
};

beforeEach(() => {
  db.current = fakePostgrest();
  Object.assign(db.current.tables, { users: [], user_wallets: [], auth_sessions: [], auth_nonces: [], password_credentials: [] });
  db.current.tables.access_allowlist = [{ kind: "wallet", value: ADDRESS }, { kind: "email", value: "listed@example.com" }];
  ban.active = false;
  vi.stubEnv("TEAM_ACCESS_CODE", "the-team-code");
});
afterEach(() => vi.unstubAllEnvs());

describe("a wallet on the access list", () => {
  it("gets a beta account at its first login, with its wallet", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(tables().users).toHaveLength(1);
    expect(tables().users[0].role).toBe("beta");
    expect(tables().user_wallets).toEqual([expect.objectContaining({ user_id: tables().users[0].id, address: ADDRESS, is_primary: true })]);
  });

  it("lifts an account that was created as 'user' at its next login", async () => {
    account("user");
    expect((await login()).status).toBe(200);
    expect(roleOf("u1")).toBe("beta");
    expect(tables().users).toHaveLength(1);
  });

  it.each(["admin", "mod", "beta"])("leaves a %s account's role alone", async (role) => {
    account(role);
    expect((await login()).status).toBe(200);
    expect(roleOf("u1")).toBe(role);
  });

  it("does not lift a banned account", async () => {
    account("user");
    ban.active = true;
    const res = await login();
    expect(res.status).toBe(200);
    expect((await res.json()).banned).toBe(true);
    expect(roleOf("u1")).toBe("user");
  });
});

describe("outside the rule", () => {
  it("a wallet that is not on the list is turned away and gets no account", async () => {
    tables().access_allowlist = [];
    const res = await login();
    expect(res.status).toBe(403);
    expect((await res.json()).notWhitelisted).toBe(true);
    expect(tables().users).toEqual([]);
  });

  it("once the whitelist stage is over, a new account keeps the default role", async () => {
    vi.stubEnv("TEAM_ACCESS_CODE", "");
    tables().access_allowlist = [];
    expect((await login()).status).toBe(200);
    expect(tables().users).toHaveLength(1);
    expect(tables().users[0].role).toBe("user");
  });

  it("a failed role update never fails the login", async () => {
    account("user");
    db.current!.state.failNext = { table: "users", op: "update", code: "XX000" };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await login()).status).toBe(200);
    expect(roleOf("u1")).toBe("user");
    expect(quiet).toHaveBeenCalledWith("[allowlist] could not admit the account:", "boom");
    quiet.mockRestore();
  });
});

describe("an email on the access list", () => {
  it("is lifted by a password login, and not when banned", async () => {
    tables().users.push({ id: "e1", role: "user" }, { id: "e2", role: "user" });
    await openLoginSession(db.current!.client, "e1", "listed@example.com", null);
    expect(roleOf("e1")).toBe("beta");
    ban.active = true;
    await openLoginSession(db.current!.client, "e2", "listed@example.com", null);
    expect(roleOf("e2")).toBe("user");
  });

  it("registers as a beta account once sign-up is open", async () => {
    vi.stubEnv("SIGNUP_OPEN", "1");
    const res = await register(new NextRequest("http://enki.test/api/auth/password/register", {
      method: "POST", body: JSON.stringify({ email: "listed@example.com", password: "a long password" }),
    }));
    expect(res.status).toBe(200);
    expect(tables().users).toEqual([expect.objectContaining({ role: "beta", account_status: "active" })]);
  });

  it("a password reset that ends in a login lifts the account too", () => {
    const reset = readSource(join(__dirname, "..", "..", "app", "api", "auth", "password", "reset-code", "route.ts"));
    expect(reset).toMatch(/if \("error" in result\) return NextResponse\.json\(\{ error: result\.error \}, \{ status: 500 \}\);\n\s*if \(!banned\) await admitAllowlisted\(supabase, row\.user_id\);/);
  });
});

describe("admitAllowlisted", () => {
  it("touches the one account and only the role 'user'", async () => {
    tables().users.push({ id: "a", role: "user" }, { id: "b", role: "user" }, { id: "c", role: "admin" });
    await admitAllowlisted(db.current!.client, "a");
    await admitAllowlisted(db.current!.client, "c");
    expect(tables().users.map((u) => u.role)).toEqual(["beta", "user", "admin"]);
  });
});
