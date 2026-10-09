import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { admitsOnceWhitelistEnded } from "@/components/BetaGate";

/**
 * SOC-8: once the whitelist stage has ended (TEAM_ACCESS_CODE unset),
 * BetaGate admits every signed-in, non-banned account regardless of role.
 * During the stage, nothing changes.
 *
 * admitsOnceWhitelistEnded is a real, exported pure function — tested here
 * behaviorally, not by source regex, because it is the one piece of this
 * ticket's logic that doesn't need a rendered component to verify. The
 * surrounding wiring (which call site passes activeAccount, the ban branch,
 * PUBLIC_PATHS) is still only regex-checkable, matching this repo's existing
 * pattern for client components the suite can't render (see
 * beta-gate-recheck.test.ts, banned-door.test.ts).
 */

describe("admitsOnceWhitelistEnded", () => {
  it("admits a confirmed account once the stage has ended", () => {
    expect(admitsOnceWhitelistEnded(true, false)).toBe(true);
  });

  it("still requires the role/allowlist rules while the stage is active", () => {
    expect(admitsOnceWhitelistEnded(true, true)).toBe(false);
  });

  it("never admits a plain visitor (no confirmed account), stage or no stage", () => {
    expect(admitsOnceWhitelistEnded(false, false)).toBe(false);
    expect(admitsOnceWhitelistEnded(false, true)).toBe(false);
  });
});

describe("BetaGate wiring (SOC-8)", () => {
  const GATE = readSource(join(__dirname, "..", "..", "components", "BetaGate.tsx"));

  it("passes activeAccount=true only from the role-mismatch branch, where a real account was already confirmed", () => {
    expect(GATE).toContain("else void teamFallback(true);");
  });

  it("the signed-out branch still calls teamFallback with no argument (unchanged)", () => {
    expect(GATE).toMatch(/forgetPill\(\);\s*void teamFallback\(\);\s*return \(\) => \{ dead = true; \};/);
  });

  it("the failed-request / non-ok-response branches still call teamFallback with no argument (unchanged)", () => {
    expect(GATE).toMatch(/if \(!res\.ok\) \{ if \(res\.status === 401\) forgetPill\(\); void teamFallback\(\); return; \}/);
    expect(GATE).toMatch(/\} catch \{\s*if \(!dead\) void teamFallback\(\);\s*\}/);
  });

  it("the banned-account 403 branch is untouched: still fires before any role/whitelist decision", () => {
    expect(GATE).toMatch(/if \(res\.status === 403 && \(await res\.json\(\)\.catch\(\(\) => null\)\)\?\.banned\) \{\n\s+if \(window\.location\.pathname !== "\/banned"\) window\.location\.href = "\/banned";/);
  });

  it("whitelistActive defaults to true (still active) when /api/gate's answer is missing or malformed", () => {
    expect(GATE).toContain('const whitelistActive = d?.whitelistActive !== false;');
  });
});
