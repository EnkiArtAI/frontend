import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CurtainImage, { keyStep } from "@/components/enki/CurtainImage";

/**
 * No DOM environment is installed, so this is a markup smoke test: the card
 * gets two image layers, the edge and both tags only when a before exists.
 */
const render = (before: string | null) =>
  renderToStaticMarkup(createElement(CurtainImage, { after: "https://cdn.example/after.webp", before, alt: "Ember Split" }));

describe("CurtainImage", () => {
  it("with a before: output image, hidden input layer, edge line and both tags", () => {
    const html = render("https://cdn.example/before.webp");
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('src="https://cdn.example/after.webp" alt="Ember Split"');
    expect(html).toContain('class="enki-curtain-before" aria-hidden="true"');
    expect(html).toContain('src="https://cdn.example/before.webp" alt=""');
    expect(html).toContain("<line ");
    expect(html).toContain(">Input<");
    expect(html).toContain(">Output<");
  });

  it("both layers load lazily: a feed page must not fetch 24 hidden before images on mount", () => {
    const html = render("https://cdn.example/before.webp");
    expect(html.match(/<img [^>]*loading="lazy"[^>]*decoding="async"/g)).toHaveLength(2);
  });

  it("without a before: the output image alone", () => {
    const html = render(null);
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).not.toContain("enki-curtain-before");
    expect(html).not.toContain("Input");
    expect(html).not.toContain("Output");
  });
});

describe("keyStep", () => {
  const host = {} as EventTarget;
  const key = (k: string, target: EventTarget = host) => ({ key: k, target }) as unknown as KeyboardEvent;

  it("steps the edge from the host: right starts at the left edge, left walks back", () => {
    expect(keyStep(key("ArrowRight"), host, -0.25)).toBeCloseTo(0.15);
    expect(keyStep(key("ArrowRight"), host, 0.5)).toBeCloseTo(0.65);
    expect(keyStep(key("ArrowLeft"), host, 0.5)).toBeCloseTo(0.35);
    expect(keyStep(key("Tab"), host, 0.5)).toBeNull();
  });

  it("ignores arrows typed into a nested control, so the bookmark input keeps its caret", () => {
    const input = {} as EventTarget;
    expect(keyStep(key("ArrowLeft", input), host, 0.5)).toBeNull();
    expect(keyStep(key("ArrowRight", input), host, 0.5)).toBeNull();
  });
});
