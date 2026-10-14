import { describe, it, expect } from "vitest";
import { formatAgo, downloadName, initials } from "../format";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const before = (ms: number) => NOW - ms;
const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

describe("formatAgo", () => {
  it("long: just now, minutes, hours, yesterday, days, weeks", () => {
    expect(formatAgo(before(30 * S), NOW)).toBe("just now");
    expect(formatAgo(before(5 * M), NOW)).toBe("5m ago");
    expect(formatAgo(before(59 * M + 59 * S), NOW)).toBe("59m ago");
    expect(formatAgo(before(90 * M), NOW)).toBe("1h ago");
    expect(formatAgo(before(2 * H + 5 * M), NOW)).toBe("2h ago");
    expect(formatAgo(before(23 * H), NOW)).toBe("23h ago");
    expect(formatAgo(before(30 * H), NOW)).toBe("yesterday");
    expect(formatAgo(before(2 * D), NOW)).toBe("2d ago");
    expect(formatAgo(before(3 * D), NOW)).toBe("3d ago");
    expect(formatAgo(before(8 * D), NOW)).toBe("1w ago");
    expect(formatAgo(before(34 * D), NOW)).toBe("4w ago");
  });

  it("short: now, 5m, 2h, 1d, 3w", () => {
    expect(formatAgo(before(30 * S), NOW, "short")).toBe("now");
    expect(formatAgo(before(5 * M), NOW, "short")).toBe("5m");
    expect(formatAgo(before(2 * H), NOW, "short")).toBe("2h");
    expect(formatAgo(before(30 * H), NOW, "short")).toBe("1d");
    expect(formatAgo(before(21 * D), NOW, "short")).toBe("3w");
  });

  it("gives the date from five weeks on, with the year only when it differs", () => {
    expect(formatAgo("2026-08-09T12:00:00Z", NOW)).toBe("Aug 9");
    expect(formatAgo("2026-08-09T12:00:00Z", NOW, "short")).toBe("Aug 9");
    expect(formatAgo("2025-08-09T12:00:00Z", NOW)).toBe("Aug 9, 2025");
    expect(formatAgo(before(35 * D), NOW)).toBe("Sep 4");
  });

  it("reads an ISO string, says just now for a clock ahead of ours, and nothing for garbage", () => {
    expect(formatAgo("2026-10-09T09:00:00Z", NOW)).toBe("3h ago");
    expect(formatAgo(NOW + 5 * M, NOW)).toBe("just now");
    expect(formatAgo("not a date", NOW)).toBe("");
  });
});

describe("downloadName", () => {
  it("is the title's slug, the number and the type's extension", () => {
    expect(downloadName("  Misty Harbor, at dawn!", 3, "image/webp")).toBe("misty-harbor-at-dawn-3.webp");
    expect(downloadName("Cat", 1, "image/png")).toBe("cat-1.png");
    expect(downloadName("Cat", 2, "image/jpeg")).toBe("cat-2.jpg");
  });

  it("falls back to webp and to a name when the title has no letters", () => {
    expect(downloadName("Cat", 1, "")).toBe("cat-1.webp");
    expect(downloadName("名前", 4, "image/webp")).toBe("enki-4.webp");
  });
});

describe("initials", () => {
  it("is the first two letters or digits, upper case, else ?", () => {
    expect(initials("amara.dev")).toBe("AM");
    expect(initials("MaraK")).toBe("MA");
    expect(initials("@x_9")).toBe("X9");
    expect(initials("")).toBe("?");
    expect(initials("._")).toBe("?");
  });
});
