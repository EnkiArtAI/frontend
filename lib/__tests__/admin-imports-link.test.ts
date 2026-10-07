import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The admin panel's "Pending imports" is the queue referred links land in.
 * An entry has no title until a moderator gives it one, so the link is what
 * identifies it: it must be findable and must read as where it leads.
 */
const ADMIN = readSource(join(__dirname, "..", "..", "app", "admin", "page.tsx"));

describe("a referred link in Pending imports", () => {
  it("is found by searching for its link", () => {
    expect(ADMIN).toContain('|| (r.url ?? "").toLowerCase().includes(q));');
  });

  it("shows its whole host before anything of its path", () => {
    // Cut at 30 characters, "x.com.artist.status.1234567890.evil.example" read as x.com.
    const label = ADMIN.slice(ADMIN.indexOf("function linkLabel(url: string): string {"), ADMIN.indexOf("type Tab = "));
    expect(label).toContain("const u = new URL(url);");
    expect(label).toContain('return u.hostname + (rest.length > 24 ? rest.slice(0, 24) + "…" : rest);');
    expect(ADMIN).toContain("{linkLabel(r.url)}");
    expect(ADMIN).not.toContain(".slice(0, 30)}…");
  });
});
