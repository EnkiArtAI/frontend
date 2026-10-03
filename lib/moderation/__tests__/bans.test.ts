import { describe, it, expect } from "vitest";
import { laterEnd } from "@/lib/moderation/bans";

/** One rule for every ban landing on a running one (round-3 review, 2026-10-03). */
describe("the later end", () => {
  it("keeps the later of two ends", () => {
    expect(laterEnd("2026-10-06T00:00:00Z", "2026-11-02T00:00:00Z")).toBe("2026-11-02T00:00:00Z");
    expect(laterEnd("2026-11-02T00:00:00Z", "2026-10-06T00:00:00Z")).toBe("2026-11-02T00:00:00Z");
  });

  it("treats for good as the latest", () => {
    expect(laterEnd("2026-10-06T00:00:00Z", null)).toBeNull();
    expect(laterEnd(null, "2026-11-02T00:00:00Z")).toBeNull();
  });

  it("compares instants, not text, whatever offset Postgres writes", () => {
    // 01:00+02:00 is 23:00Z the day before: earlier, though it sorts later as text.
    expect(laterEnd("2026-10-07T01:00:00+02:00", "2026-10-06T23:30:00Z")).toBe("2026-10-06T23:30:00Z");
  });
});
