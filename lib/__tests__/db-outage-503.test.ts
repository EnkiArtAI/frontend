import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { DbUnreachableError } from "@/lib/db-error";

/**
 * A database outage answers 503 DB_UNAVAILABLE, never 401 "sign in". The
 * session resolvers threw DbUnreachableError and two helpers swallowed it as
 * "nobody", so every route behind them told a signed-in user to log in again
 * (Supabase was paused for days in September; users looped through login).
 */

const outage = vi.hoisted(() => ({ kind: null as null | "down" | "broken" }));
vi.mock("@/lib/session-user", async (orig) => {
  const real = await orig<typeof import("@/lib/session-user")>();
  const fail = async () => {
    if (outage.kind === "down") throw new (await import("@/lib/db-error")).DbUnreachableError();
    throw new Error("something else broke");
  };
  return { ...real, resolveSessionUserWithBan: fail, resolveSessionUserId: fail };
});
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({}), getSupabaseServerClientSafe: () => ({}) }));

import { authRefusal, requireAuth } from "@/lib/auth";
import { resolveRecordingUserId } from "@/lib/generation/record";
import { POST as authorize } from "../../app/api/payments/generation/authorize/route";
import { POST as submit } from "../../app/api/payments/generation/submit/route";
import { POST as passkeyOptions } from "../../app/api/auth/passkey/register/options/route";

const signedIn = (path: string) =>
  new NextRequest(`http://enki.test${path}`, { method: "POST", headers: { "X-Session-Token": "tok" }, body: "{}" });

beforeEach(() => { outage.kind = null; });

describe("a database outage", () => {
  it("is 503 DB_UNAVAILABLE from authRefusal; anything else stays 401", async () => {
    const down = authRefusal(new DbUnreachableError());
    expect(down.status).toBe(503);
    expect((await down.json()).code).toBe("DB_UNAVAILABLE");
    const other = authRefusal(new Error("bad token"), "Not signed in");
    expect(other.status).toBe(401);
    expect(await other.json()).toEqual({ error: "Not signed in" });
  });

  it("reaches the caller of requireAuth and of resolveRecordingUserId, while other errors still mean nobody", async () => {
    outage.kind = "down";
    await expect(requireAuth(signedIn("/x"))).rejects.toBeInstanceOf(DbUnreachableError);
    await expect(resolveRecordingUserId({} as never, signedIn("/x"))).rejects.toBeInstanceOf(DbUnreachableError);
    outage.kind = "broken";
    await expect(requireAuth(signedIn("/x"))).rejects.toThrow(/valid session token is required/);
    expect(await resolveRecordingUserId({} as never, signedIn("/x"))).toBeNull();
  });

  it("answers 503 on the paid rail and on passkey setup instead of 'sign in'", async () => {
    outage.kind = "down";
    for (const res of [await authorize(signedIn("/api/payments/generation/authorize")), await submit(signedIn("/api/payments/generation/submit")), await passkeyOptions(signedIn("/api/auth/passkey/register/options"))]) {
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("DB_UNAVAILABLE");
    }
    outage.kind = "broken";
    expect((await authorize(signedIn("/api/payments/generation/authorize"))).status).toBe(401);
  });

  it("is answered the same way by every route that signs its caller in", () => {
    const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));
    for (const r of ["intent", "quote"]) {
      expect(src("app", "api", "payments", "generation", r, "route.ts")).toMatch(/\} catch \(e\) \{\n\s+return authRefusal\(e\);/);
    }
    expect(src("app", "api", "payments", "generation", "submit", "route.ts")).toContain('return escrowRoute(req, "submit",');
    expect(src("lib", "payments", "escrow", "server-route.ts")).toContain("catch (error) { return authRefusal(error); }");
    expect(src("app", "api", "workflow", "variables", "route.ts")).toMatch(/\} catch \(e\) \{\n\s+return authRefusal\(e\);/);
    expect(src("app", "api", "auth", "passkey", "register", "verify", "route.ts")).toMatch(/\} catch \(e\) \{\n\s+return authRefusal\(e, "Not signed in"\);/);
    expect(src("app", "api", "prompts", "[id]", "route.ts")).toMatch(/\} catch \(e\) \{\n\s+if \(isDbUnreachable\(e\)\) return dbUnavailableResponse\(\);\n\s+return NextResponse\.json\(\{ error: "Authentication required" \}, \{ status: 401 \}\);/);
    for (const route of ["generate-free", "generate-image"]) {
      expect(src("app", "api", route, "route.ts")).toMatch(/if \(isDbUnreachable\(e\)\) return dbUnavailableResponse\(\);\n\s+return NextResponse\.json\(SILENT_FAILURE, \{ status: 500 \}\);/);
    }
  });

  it("persists the accepted paid image before acknowledging delivery, with safe pending failures", () => {
    const paid = readSource(join(__dirname, "..", "..", "app", "api", "generate-image", "route.ts"));
    const record = paid.indexOf("const recorded = await recordGeneration(");
    const deliver = paid.indexOf("await deliverGenerationEscrowUnit(");
    expect(record).toBeGreaterThan(-1);
    expect(deliver).toBeGreaterThan(record);
    expect(paid).toContain("requireAcceptedImage: true");
    expect(paid).toContain("if (e instanceof GenerationRecordError)");
    expect(paid).toContain("refundPending: true");
    expect(paid).toContain("reconciliationPending");
  });
});

describe("generate-image, the paid render", () => {
  const route = readSource(join(__dirname, "..", "..", "app", "api", "generate-image", "route.ts"));

  it("answers an outage while reading the intent with 503, not 'intent not found'", () => {
    expect(route).toContain("if (isDbUnreachable(intentError)) return dbUnavailableResponse();");
  });

  it("answers an outage while reading the session with 503, not 'sign in'", () => {
    expect(route).toMatch(/authUser = await requireAuth\(request\);\n\s+\} catch \(e\) \{\n\s+return authRefusal\(e\);/);
  });
});
