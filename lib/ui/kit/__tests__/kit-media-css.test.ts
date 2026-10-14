import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * What only the stylesheet and the wiring can say, pinned: the viewer's
 * layer, the mirror's metrics, tokens that never move a glyph, and the
 * viewer's Esc giving way to a sheet over it.
 */
const src = (...p: string[]) => readSource(join(__dirname, "..", "..", "..", "..", ...p));
const css = src("components", "kit", "kit-media.css");
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};
const declared = (selector: string) => rule(selector).replace(/^[^{]*\{/, "");

describe("kit-media.css", () => {
  it("puts the viewer at 9999: over the page and its popovers, under the sheets and dialogs", () => {
    expect(rule(".kit-viewer")).toContain("z-index: 9999;");
    expect(src("components", "kit", "kit-controls.css")).toMatch(/\n\.kit-sheet-layer \{[^}]*z-index: 10000;/);
  });

  it("gives the textarea and its mirror one rule for box and type", () => {
    const shared = rule(".kit-pm-text,\n.kit-pm-mirror");
    for (const d of ["padding: var(--kit-pad", "border: 1px solid transparent;", "font: 400 var(--kit-fs", "letter-spacing: normal;", "white-space: pre-wrap;", "overflow-wrap: break-word;", "box-sizing: border-box;"]) {
      expect(shared).toContain(d);
    }
    // On a touch screen both grow to 16 px together, by a selector that outranks a surface's own size.
    expect(css).toMatch(/@media \(pointer: coarse\) \{\n\s+textarea\.kit-autosize,\n\s+div\.kit-pm-mirror \{ font-size: max\(16px, var\(--kit-fs, 16px\)\); \}/);
  });

  it("lets a token change background and colour only, never the box or the type", () => {
    const tokens = [".kit-tok", ".kit-tok--var", ".kit-tok--blank", ".kit-tok--ref", ".kit-tok--ref.is-missing", ".kit-tok-br"];
    for (const t of tokens) {
      const body = declared(t);
      expect(body, t).not.toBe("");
      expect(body, t).not.toMatch(/(^|[\s;])(padding|margin|font|font-[a-z]+|letter-spacing|word-spacing|border|border-width|line-height)\s*:/);
    }
  });

  it("never stops a long press from saving the viewer's image", () => {
    expect(css).not.toMatch(/-webkit-touch-callout/);
    expect(declared(".kit-viewer-box img")).not.toMatch(/user-select|pointer-events/);
    const viewer = src("components", "kit", "FullscreenViewer.tsx");
    expect(viewer).not.toMatch(/onContextMenu|onTouchStart/);
  });
});

describe("the viewer's keys", () => {
  const viewer = src("components", "kit", "FullscreenViewer.tsx");

  it("listen in the capture phase and stop there, so the page's own Esc never hears them", () => {
    expect(viewer).toContain('window.addEventListener("keydown", key, true);');
    expect(viewer).toMatch(/if \(!act\) return;\n\s+e\.stopPropagation\(\);/);
  });

  it("give way to a bottom sheet open over the viewer, by the class the sheet carries", () => {
    expect(viewer).toContain('sheet: !!document.querySelector(".kit-sheet-layer"),');
    expect(src("components", "kit", "BottomSheet.tsx")).toContain("<div className={`kit-sheet-layer${");
  });
});
