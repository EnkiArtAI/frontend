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

describe("the ban that holds", () => {
  it("is the active one that lasts longest, not the newest", async () => {
    const { activeBanFor } = await import("@/lib/session-user");
    const now = Date.now();
    const rows = [
      { id: "perm", user_id: "u1", lifted_at: null, expires_at: null, created_at: "2026-10-01T00:00:00Z", reason: "for good" },
      { id: "short", user_id: "u1", lifted_at: null, expires_at: new Date(now + 3 * 86400_000).toISOString(), created_at: "2026-10-03T00:00:00Z", reason: "3 days" },
      { id: "over", user_id: "u1", lifted_at: null, expires_at: new Date(now - 1000).toISOString(), created_at: "2026-10-03T01:00:00Z", reason: "ran out" },
    ];
    let filtered = rows;
    const sorts: [string, boolean, boolean][] = [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filtered = filtered.filter((r) => (r as Record<string, unknown>)[c] === v); return q; },
      is: () => q,
      or: () => { filtered = filtered.filter((r) => r.expires_at === null || Date.parse(r.expires_at) > now); return q; },
      order: (c: string, o: { ascending: boolean; nullsFirst?: boolean }) => { sorts.push([c, o.ascending, o.nullsFirst === true]); return q; },
      limit: async () => {
        const sorted = [...filtered].sort((a, b) => {
          for (const [c, asc, nullsFirst] of sorts) {
            const x = (a as Record<string, unknown>)[c] as string | null, y = (b as Record<string, unknown>)[c] as string | null;
            if (x === y) continue;
            if (x === null) return nullsFirst ? -1 : 1;
            if (y === null) return nullsFirst ? 1 : -1;
            return (asc ? 1 : -1) * (x < y ? -1 : 1);
          }
          return 0;
        });
        return { data: sorted.slice(0, 1), error: null };
      },
    };
    const fake = { from: () => q } as never;
    expect((await activeBanFor(fake, "u1"))?.id).toBe("perm");
  });
});
