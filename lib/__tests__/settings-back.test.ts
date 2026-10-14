import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/* Settings' Back (Kev, 2026-10-13): a pill at the top left that stays while
   the page scrolls; the shell closes its panel with it, standalone /settings
   goes to the page before (Home when there is none). Pinned on the source. */
const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

describe("Settings' Back", () => {
  it("sits in the free space left of the column, against it, and sticks while the page scrolls; above the column where there is no space", () => {
    const layout = src("components", "settings", "SettingsLayout.tsx");
    expect(layout).toMatch(/<div className="set-page">\n\s+<button type="button" className="set-back" onClick=\{onBack\}>[\s\S]*?<\/button>\n\s+<div className="set-container">/);
    const css = src("components", "settings", "settings.css");
    expect(css).toMatch(/\.set-page \{\n\s+display: grid;\n\s+grid-template-columns: minmax\(0, 1fr\) minmax\(0, 760px\) minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.set-back \{\n\s+grid-column: 1;\n\s+justify-self: end;\n\s+position: sticky;\n\s+top: 12px;/);
    expect(css).toMatch(/@media \(max-width: 959\.98px\) \{\n\s+\.set-page \{ display: block; \}\n\s+\.set-back \{ margin: 12px 0 -18px 16px; \}/);
  });

  it("closes the shell's panel, or leaves standalone /settings for the page before", () => {
    const view = src("components", "settings", "SettingsView.tsx");
    expect(view).toContain('const back = onBack ?? (() => (window.history.length > 1 ? router.back() : router.push("/home")));');
    expect(view).toContain("onBack={back}");
    const shell = src("components", "enki-shell", "EnkiHome.tsx");
    expect(shell.split("onBack={closePanel} />").length - 1).toBeGreaterThanOrEqual(3); // creator profile, billing, settings
  });
});
