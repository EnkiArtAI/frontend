import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * A guardian recovery resets the password and nothing else (Kev,
 * 2026-10-07): passkeys and code factors stay. Whoever completes a recovery,
 * the owner or someone who talked the guardians round, gets a session that
 * still needs the old factors for every gated action, withdraw included.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
// Before the imports below: the password hash and the step-up read the pepper.
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64"); });

import { POST as complete } from "../../app/api/recovery/complete/route";
import { requireStepUp } from "../webauthn";

const U = "11111111-1111-4111-8111-111111111111";
const R = "33333333-3333-4333-8333-333333333333";
const KEY = "owner-key-kept-in-the-browser";

describe("a completed guardian recovery", () => {
  it("keeps every factor, so the new session still needs one to remove them", async () => {
    db.current = fakePostgrest();
    const t = db.current.tables;
    t.recovery_requests = [{
      id: R, user_id: U, status: "approved",
      owner_key_hash: createHash("sha256").update(KEY).digest("hex"),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }];
    t.password_credentials = [{ user_id: U, email: "me@example.com" }];
    t.user_wallets = [];
    t.auth_sessions = [{ token: "old", wallet_address: U }];
    t.webauthn_credentials = [{ id: "pk1", user_id: U }];
    t.mfa_factors = [{ id: "f1", user_id: U, kind: "totp", confirmed_at: "2026-10-01T00:00:00Z" }];

    const res = await complete(new NextRequest("http://enki.test/api/recovery/complete", {
      method: "POST",
      body: JSON.stringify({ requestId: R, ownerKey: KEY, password: "a new password" }),
    }));
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect(t.auth_sessions.map((s) => s.token)).toEqual([token]);

    expect(t.webauthn_credentials).toHaveLength(1);
    expect(t.mfa_factors).toHaveLength(1);
    const asked = await requireStepUp(
      new NextRequest("http://enki.test/x", { headers: { "X-Session-Token": token } }),
      U,
      "remove-factor:totp",
      { mandatory: true },
    );
    expect(asked?.status).toBe(401);
    expect((await asked!.json()).factors).toEqual(["passkey", "totp"]);
  });
});
