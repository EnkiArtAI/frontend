import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The portaled picker panel (components/kit/panel-pos usePanelPos) closes on
 * a scroll so it never sits detached from its pill; a window listener in the
 * capture phase also hears the panel's own list scrolling, which is reading
 * the options, not leaving them. A hook on window events: pinned on source.
 */
const PANEL = readSource(join(__dirname, "..", "..", "..", "..", "components", "kit", "panel-pos.ts"));

describe("an open picker panel", () => {
  it("stays open while its own list scrolls, and closes on any other scroll", () => {
    expect(PANEL).toMatch(/const onScroll = \(e: Event\) => \{\n\s*if \(!panelRef\.current\?\.contains\(e\.target as Node\)\) close\(\);\n\s*\};/);
    expect(PANEL).toContain('window.addEventListener("scroll", onScroll, true);');
    expect(PANEL).toContain('window.removeEventListener("scroll", onScroll, true);');
    expect(PANEL).not.toContain('"scroll", close');
  });
});
