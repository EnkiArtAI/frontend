import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/* Settings' Back (Kev, 2026-10-13): a pill at the top left that stays while
   the page scrolls; the shell closes its panel with it, standalone /settings
   goes to the page before (Home when there is none). Pinned on the source. */
const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

describe("Settings' Back", () => {
  it("is the first thing in the layout and sticks to the top left", () => {
    const layout = src("components", "settings", "SettingsLayout.tsx");
    expect(layout).toMatch(/<div className="set-container">\n\s+<button type="button" className="set-back" onClick=\{onBack\}>/);
    const css = src("components", "settings", "settings.css");
    expect(css).toMatch(/\.set-back \{\n\s+position: sticky;\n\s+top: 12px;/);
  });

  it("closes the shell's panel, or leaves standalone /settings for the page before", () => {
    const view = src("components", "settings", "SettingsView.tsx");
    expect(view).toContain('const back = onBack ?? (() => (window.history.length > 1 ? router.back() : router.push("/home")));');
    expect(view).toContain("onBack={back}");
    const shell = src("components", "enki-shell", "EnkiHome.tsx");
    expect(shell.split("onBack={closePanel} />").length - 1).toBeGreaterThanOrEqual(3); // creator profile, billing, settings
  });
});
