import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * MFA-1: a step-up token for a money scope (withdraw, export) authorizes at
 * most ONE action. Earlier scopes (delete-work, add-factor, guardians,
 * remove-factor, wallet) are untouched: still good for any number of calls
 * inside the 5 minute TTL, exactly as before this change. The claim lives in
 * consumed_stepup_tokens (migrations/2026-10-09-consumed-stepup-tokens.sql),
 * not memory — Vercel runs many instances.
 */

const db = fakePostgrest();
const supabase = db.client;
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => supabase }));

process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");

import { requireStepUp, mintStepUpToken } from "../webauthn";

const U = "11111111-1111-4111-8111-111111111111";
const req = (token?: string) => new NextRequest("http://enki.test/x", { headers: token ? { "X-StepUp-Token": token } : {} });

beforeEach(() => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  db.tables.webauthn_credentials = [];
  db.tables.mfa_factors = [{ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" }];
  db.tables.consumed_stepup_tokens = [];
  db.state.failing = null;
});

describe("single-use money scopes", () => {
  it("lets an export token through once, then refuses the identical token", async () => {
    const token = await mintStepUpToken(U, "export");
    expect(await requireStepUp(req(token), U, "export")).toBeNull();
    const replay = await requireStepUp(req(token), U, "export");
    expect(replay).not.toBeNull();
    expect(replay!.status).toBe(401);
    expect((await replay!.json()).stepUp).toBe(true);
  });

  it("fails closed when the consumed-token store errors, never passing silently", async () => {
    const token = await mintStepUpToken(U, "export");
    db.state.failing = { table: "consumed_stepup_tokens", code: "XX000" };
    const res = await requireStepUp(req(token), U, "export");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });

  it("leaves a non-money scope exactly as reusable as before", async () => {
    const scope = "delete-work:1a2b3c4d-1111-4222-8333-444455556666";
    const token = await mintStepUpToken(U, scope);
    expect(await requireStepUp(req(token), U, scope)).toBeNull();
    // Same token, same scope, second call: still fine — delete-work is not a money scope.
    expect(await requireStepUp(req(token), U, scope)).toBeNull();
    expect(db.tables.consumed_stepup_tokens).toHaveLength(0);
  });

  it("every minted token carries a jti", async () => {
    const [a, b] = await Promise.all([mintStepUpToken(U, "export"), mintStepUpToken(U, "export")]);
    const decode = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
    expect(decode(a).jti).toBeTruthy();
    expect(decode(b).jti).toBeTruthy();
    expect(decode(a).jti).not.toBe(decode(b).jti);
  });
});
