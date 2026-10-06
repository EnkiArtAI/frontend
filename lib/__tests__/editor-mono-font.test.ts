import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * enki-editor.css used --enk-font-mono 21 times and never defined it, so every
 * mono run in the editor fell back to the sans face. The fix sat uncommitted in
 * an old worktree since 2026-08-12 (rescued 2026-10-06).
 */

const ROOT = join(__dirname, "..", "..");
const CSS = readFileSync(join(ROOT, "app", "editor", "enki-editor.css"), "utf8").split("\r\n").join("\n");
const LAYOUT = readFileSync(join(ROOT, "app", "layout.tsx"), "utf8");

describe("the editor's mono font", () => {
  it("is defined on body, where next/font puts the JetBrains Mono variable", () => {
    expect(CSS).toMatch(/\nbody \{\n\s+--enk-font-mono: var\(--font-jetbrains-mono\), ui-monospace, monospace;\n\}/);
    expect(LAYOUT).toMatch(/variable: "--font-jetbrains-mono"/);
  });

  it("is used where the editor asks for it", () => {
    expect(CSS.split("var(--enk-font-mono").length - 1).toBeGreaterThan(1);
  });
});
