import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { gateNext } from "@/lib/gate-next";

/**
 * After a correct access code the gate goes on to ?next=…, which anyone can
 * write into a link sent to a team member.
 */
describe("where the gate goes after a correct code", () => {
  it("is the page of this site the visitor was sent to the gate for", () => {
    expect(gateNext("/editor")).toBe("/editor");
    expect(gateNext("/generator/abc?tab=2#top")).toBe("/generator/abc?tab=2#top");
    expect(gateNext("/")).toBe("/");
  });

  it("is home when nothing was asked for", () => {
    expect(gateNext(null)).toBe("/home");
    expect(gateNext(undefined)).toBe("/home");
    expect(gateNext("")).toBe("/home");
  });

  it.each([
    ["a script", "javascript:alert(document.domain)"],
    ["a script in other case", "JaVaScRiPt:alert(1)"],
    ["a data page", "data:text/html,<script>alert(1)</script>"],
    ["another site", "https://evil.example/login"],
    ["another site without a protocol", "//evil.example/login"],
    ["another site behind a backslash", "/" + String.fromCharCode(92) + "evil.example/login"],
    ["a path without its slash", "editor"],
    ["a link without its slashes", "https:evil.example"],
    ["a space before a script", " javascript:alert(1)"],
  ])("is home, never %s", (_name, next) => {
    expect(gateNext(next)).toBe("/home");
  });

  it("is what the gate page follows", () => {
    const PAGE = readSource(join(__dirname, "..", "..", "app", "gate", "page.tsx"));
    expect(PAGE).toContain('window.location.href = gateNext(new URLSearchParams(window.location.search).get("next"));');
    expect(PAGE.split("window.location.href =")).toHaveLength(2);
  });
});
