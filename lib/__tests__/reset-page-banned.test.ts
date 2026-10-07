import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * An inbox reset enters like a login (Kev, 2026-10-07): reset-code answers
 * { banned } for a banned account, and the reset page sends it to /banned
 * (status, appeal, funds) instead of an app that resolves it to nobody.
 */

const PAGE = readSource(join(__dirname, "..", "..", "app", "reset-password", "page.tsx"));

describe("the reset page", () => {
  it("sends a banned account to /banned after an inbox reset, anyone else home", () => {
    expect(PAGE).toMatch(/setTimeout\(\(\) => goHome\(data\.banned \? "\/banned" : "\/home"\), 900\);/);
    expect(PAGE).toMatch(/const goHome = \(path = "\/home"\) => \{\s*if \(embed && window\.top && window\.top !== window\) window\.top\.location\.href = path;\s*else router\.replace\(path\);/);
  });
});
