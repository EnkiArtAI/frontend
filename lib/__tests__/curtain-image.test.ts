import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CurtainImage from "@/components/enki/CurtainImage";

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

  it("without a before: the output image alone", () => {
    const html = render(null);
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).not.toContain("enki-curtain-before");
    expect(html).not.toContain("Input");
    expect(html).not.toContain("Output");
  });
});
