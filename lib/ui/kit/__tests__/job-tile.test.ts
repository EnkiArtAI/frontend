import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { join } from "node:path";
import JobTile from "@/components/kit/JobTile";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * A render still in line can be taken back, and the spinner lights up once
 * its request has gone out (Kev, 2026-10-13: "abbrechen solange der API call
 * noch nicht abgeschickt wurde"; "der Lade-Icon soll grün leuchten,
 * Warteschlange soll weiss bleiben").
 */
const tile = (props: Partial<Parameters<typeof JobTile>[0]>) =>
  renderToStaticMarkup(createElement(JobTile, { status: "rendering", ratio: "1:1", seen: false, label: "Your render", ...props }));
const X = /<button type="button" class="kit-tile-x kit-hit" aria-label="Cancel this render"/;

describe("a job tile in line", () => {
  it("carries the X while it can be cancelled, and no lit spinner", () => {
    const html = tile({ onCancel: vi.fn() });
    expect(html).toMatch(X);
    expect(html).not.toContain("data-sent");
    expect(html).toContain('class="kit-spinner"');
  });

  it("drops the X and lights up once its request has gone out", () => {
    const html = tile({ sent: true, onCancel: vi.fn() });
    expect(html).not.toMatch(X);
    expect(html).toContain('data-sent="true"');
    expect(html).toContain('class="kit-spinner"');
  });

  it("has no X without a way to cancel, and none once it is finished", () => {
    expect(tile({})).not.toMatch(X);
    expect(tile({ status: "ready", src: "/a.png", onCancel: vi.fn() })).not.toMatch(X);
    expect(tile({ status: "failed", onCancel: vi.fn() })).not.toMatch(X);
    // A finished tile is never "sent" either, whatever the job remembers.
    expect(tile({ status: "ready", sent: true, src: "/a.png" })).not.toContain("data-sent");
  });

  it("the X is a sibling of the face, never a button inside the face's button", () => {
    const html = tile({ onCancel: vi.fn(), onClick: vi.fn() });
    expect(html).not.toMatch(/<button[^>]*class="kit-tile-face"[^>]*>(?:(?!<\/button>).)*<button/);
    expect(html).toMatch(X);
  });
});

describe("the stylesheet", () => {
  const css = readSource(join(__dirname, "..", "..", "..", "..", "components", "kit", "kit-media.css"));
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };

  it("lights only a sent tile's spinner in turq, and leaves the white one for those in line", () => {
    const lit = rule('.kit-tile[data-sent] .kit-spinner');
    expect(lit).toContain("border-top-color: var(--enki-turq);");
    expect(lit).toContain("box-shadow: 0 0 10px color-mix(in oklab, var(--enki-turq) 60%, transparent);");
    expect(rule(".kit-spinner")).toContain("border-top-color: var(--enki-on-stage);");
  });

  it("puts the X top-right, where a finished tile's ✓ goes", () => {
    const x = rule(".kit-tile-x");
    expect(x).toContain("position: absolute;");
    expect(x).toContain("top: 3px;");
    expect(x).toContain("right: 3px;");
    expect(rule(".kit-tile-check")).toContain("right: 3px;");
  });
});
