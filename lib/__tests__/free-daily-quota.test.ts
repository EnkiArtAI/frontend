import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("one free baseline-model image per UTC day", () => {
  it("checks the SQL's day reset, cap, claim release and service-only access offline", async () => {
    // Existing migration harness scripts are executable JS, not application modules.
    const { checkFreeDailyQuota } = await import("../../scripts/free-daily-quota-checks.mjs");
    expect(await checkFreeDailyQuota()).toEqual({ passed: 11 });
  }, 60_000);

  it("the free route preserves the selected model and reports the daily reset", () => {
    const source = readFileSync(join(__dirname, "../../app/api/generate-free/route.ts"), "utf8");
    expect(source).toContain('model.normal.provider !== "pollinations"');
    expect(source).toContain('Your free image for today has already been used.');
    expect(source).toContain('resetsAt: q?.resetsAt ?? null');
    expect(source.indexOf('freeGenerationDecision(supabaseForChecks, quotaUserId)')).toBeLessThan(source.indexOf('await generateImageWithPollinations('));
  });
});
