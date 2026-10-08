import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { APP_NAME } from "@/shared/app-config";

/**
 * A wallet login whose account lookup fails (the database down, or two live
 * rows for one address) answers 503 and writes nothing. It used to read the
 * failure as "no account yet", mint a new empty user on every login and skip
 * the ban check: a founder's wallet collected 16 empty users that way.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const kp = Keypair.generate();
const ADDRESS = kp.publicKey.toBase58();

const state = vi.hoisted(() => ({ walletError: null as null | { code: string; message: string }, inserts: [] as string[] }));
vi.mock("@/lib/session-user", () => ({ activeBanFor: async () => null }));
vi.mock("@/lib/ip-hash", () => ({ getClientIp: () => "203.0.113.9", hashIp: () => "iphash", isIpBanned: async () => false }));
vi.mock("@/lib/allowlist", async (orig) => ({ ...(await orig<typeof import("@/lib/allowlist")>()), whitelistStageActive: () => false }));

const chain = (table: string): unknown => {
  let one = false;
  let inserting = false;
  const row = table === "user_wallets" ? { user_id: USER, address: ADDRESS } : table === "users" ? { id: "new-user" } : null;
  const c: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown) => {
      if (inserting) state.inserts.push(table);
      const error = table === "user_wallets" && !inserting ? state.walletError : null;
      return Promise.resolve({ data: error ? null : one ? row : row ? [row] : [], error }).then(ok);
    },
    insert: () => { inserting = true; return c; },
  };
  for (const m of ["select", "update", "eq", "ilike", "is", "order", "limit", "delete", "lt"]) c[m] = () => c;
  for (const m of ["single", "maybeSingle"]) c[m] = () => { one = true; return c; };
  return c;
};
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({ from: chain, rpc: async () => ({ data: true, error: null }) }),
}));

import { POST as walletLogin } from "../../app/api/auth/session/route";

const login = () => {
  const nonce = Math.random().toString(36).slice(2);
  const message = `${APP_NAME} sign in\n${ADDRESS}\nnonce ${nonce}`;
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32))).toString("base64");
  return walletLogin(new NextRequest("http://enki.test/api/auth/session", {
    method: "POST",
    body: JSON.stringify({ walletAddress: ADDRESS, walletType: "solana", signature, message, timestamp: Date.now(), nonce }),
  }));
};

beforeEach(() => { state.walletError = null; state.inserts.length = 0; });

describe("a wallet login whose account lookup fails", () => {
  it("answers 503 and mints no user when two live rows share the address", async () => {
    state.walletError = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" };
    const res = await login();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Your account could not be read right now. Try again.");
    expect(state.inserts.filter((t) => t === "users" || t === "user_wallets")).toEqual([]);
  });

  it("answers DB_UNAVAILABLE when the database cannot be reached", async () => {
    state.walletError = { code: "", message: "TypeError: fetch failed" };
    const res = await login();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("DB_UNAVAILABLE");
    expect(state.inserts.filter((t) => t === "users")).toEqual([]);
  });

  it("logs in an existing wallet as before", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(state.inserts.filter((t) => t === "users")).toEqual([]);
  });
});
