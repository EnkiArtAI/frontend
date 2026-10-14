import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * What only the stylesheet can say, pinned: the layer numbers from the plan's
 * z table, the popover's width limit, a closing sheet letting taps through,
 * its timing, and reduced motion fading instead of sliding.
 */
const src = (...p: string[]) => readSource(join(__dirname, "..", "..", "..", "..", ...p));
const css = src("components", "kit", "kit-controls.css");
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

describe("kit-controls.css", () => {
  it("puts popovers at 9000 and sheets at 10000, above the viewer's 9999", () => {
    expect(rule(".kit-menu-panel")).toContain("z-index: 9000;");
    expect(rule(".kit-funds")).toContain("z-index: 9000;");
    expect(rule(".kit-sheet-layer")).toContain("z-index: 10000;");
  });

  it("never lets a popover grow past 100vw - 40px", () => {
    expect(rule(".kit-menu-panel")).toContain("max-width: calc(100vw - 40px);");
  });

  it("lets taps through a closing sheet, which slides up in 280 ms and down in the time BottomSheet waits", () => {
    expect(css).toContain(".kit-sheet-layer.is-closing { pointer-events: none; }");
    expect(rule(".kit-sheet")).toContain("animation: kit-sheet-up 280ms");
    const out = /\.kit-sheet-layer\.is-closing \.kit-sheet \{ animation: kit-sheet-down (\d+)ms/.exec(css)?.[1];
    const waits = /const OUT_MS = (\d+);/.exec(src("components", "kit", "BottomSheet.tsx"))?.[1];
    expect(out).toBe("260");
    expect(waits).toBe(out);
  });

  it("fades instead of sliding under reduced motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .kit-sheet-backdrop"));
    expect(reduced.slice(0, reduced.indexOf("\n}"))).toMatch(
      /^[^}]*\.kit-sheet \{ animation: kit-fade 120ms ease; \}[^}]*\.kit-sheet-layer\.is-closing \.kit-sheet \{ animation: kit-sheet-out 120ms ease forwards; \}$/,
    );
  });
});
