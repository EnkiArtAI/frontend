import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BoostToggle, { SAME_HOST, type BoostToggleProps } from "@/components/generation/BoostToggle";

/**
 * "⚡ Boost" is always there on the redesigned surfaces (handoff §0, plan R5):
 * with nothing to boost it greys out and says why instead of disappearing.
 * The icon-only toggle on today's surfaces keeps hiding itself.
 */
const html = (p: Partial<BoostToggleProps>) =>
  renderToStaticMarkup(createElement(BoostToggle, { boost: true, onChange: () => {}, ...p }));

describe("BoostToggle with label", () => {
  it("shows the word, on and pressable where a faster host exists", () => {
    const out = html({ label: true });
    expect(out).toContain(">Boost</button>");
    expect(out).toContain('aria-checked="true"');
    expect(out).not.toContain("disabled");
    expect(out).not.toContain(SAME_HOST);
  });

  it("stays rendered for a model without a faster host, disabled, off and saying why", () => {
    const out = html({ label: true, available: false });
    expect(out).toContain(">Boost</button>");
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-checked="false"');
    expect(out).toContain(`title="${SAME_HOST}"`);
  });

  it("is disabled the same way at a size whose host is already the fastest", () => {
    const out = html({ label: true, sameHost: true });
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-checked="false"');
    expect(out).toContain(`title="${SAME_HOST}"`);
  });
});

describe("BoostToggle without label (today's surfaces)", () => {
  it("is still hidden for a model without a faster host", () => {
    expect(html({ available: false })).toBe("");
  });

  it("is still the icon pair, without the word or the label look", () => {
    const out = html({});
    expect(out).toContain('aria-checked="true"');
    expect(out).not.toContain("Boost<");
    expect(out).not.toContain("data-label");
    expect(out.match(/<svg/g)).toHaveLength(2);
  });
});
