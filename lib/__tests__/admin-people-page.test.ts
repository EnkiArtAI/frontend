import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/** The People tab: one row per person key, actions that do not toggle the row. */
const PAGE = readSource(join(__dirname, "..", "..", "app", "admin", "page.tsx"));

describe("the People tab", () => {
  it("keys rows by person, so someone without an account opens too", () => {
    expect(PAGE).toMatch(/onClick=\{\(\) => void openPerson\(p\.key\)\}/);
    expect(PAGE).toMatch(/\{pplOpen === p\.key && \(/);
    expect(PAGE).toMatch(/`no account · \$\{p\.ipHash\?\.slice\(0, 8\)\}`/);
  });

  it("offers Lift only for an account, without opening the row", () => {
    expect(PAGE).toMatch(/\{p\.suspension && p\.userId && \(\s*<span onClick=\{\(e\) => e\.stopPropagation\(\)\}>/);
  });

  it("counts only open cases as needing attention", () => {
    expect(PAGE).toMatch(/people: data\?\.people\.filter\(\(p\) => p\.pending > 0\)\.length \?\? 0,/);
  });
});
