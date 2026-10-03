import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The warnings ladder issues suspensions that run out and are never lifted.
 * Every "already banned?" check must treat a run-out suspension as no ban,
 * or the next ban (auto-ban, council, manual) is silently skipped.
 */
const ROOT = join(__dirname, "..", "..", "..");

describe("an expired suspension is not a ban", () => {
  it("for the child-safety auto-ban", () => {
    const src = readSource(join(ROOT, "lib", "moderation-enforcement.ts"));
    expect(src).toMatch(/await banUntil\(supabase, \{ userId, issuedBy, expiresAt: null, reason: "Automated: child-safety classifier" \}\);/);
    // The event that caused it is linked, its evidence with it.
    expect(src).toMatch(/if \(issued\?\.id && eventId\) await supabase\.from\("automod_events"\)\.update\(\{ ban_id: issued\.id \}\)\.eq\("id", eventId\);/);
    expect(src).not.toMatch(/if \(await activeBanFor\(supabase, userId\)\) return;/);
  });

  it("for a council decision and a manual ban", () => {
    const admin = readSource(join(ROOT, "app", "api", "admin", "route.ts"));
    expect(admin).toMatch(/\.eq\("user_id", String\(p\.target_user_id\)\)\.is\("lifted_at", null\)\.or\(unexpired\(\)\)/);
    expect(admin).toMatch(/\.eq\("user_id", targetId\)\.is\("lifted_at", null\)\.or\(unexpired\(\)\)/);
    expect(admin).toMatch(/const unexpired = \(\) => `expires_at\.is\.null,expires_at\.gt\.\$\{new Date\(\)\.toISOString\(\)\}`;/);
  });
});

describe("a request made during a suspension", () => {
  it("is recorded under the account by the tier-2 event log too", () => {
    expect(readSource(join(ROOT, "lib", "moderation-enforcement.ts")))
      .toMatch(/userId = await resolveSessionUserWithBan\(supabase, token\)\.then\(\(s\) => s\.userId\)\.catch\(\(\) => null\);/);
  });
});
