import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import Segmented from "@/components/kit/Segmented";

type Seg = ReactElement<{ className: string; style?: Record<string, number> }>;

const mount = (value: "free" | "premium", slide?: boolean) =>
  Segmented({ options: [{ key: "free", label: "Open" }, { key: "premium", label: "Premium" }], value, onChange: vi.fn(), ariaLabel: "Listing", role: "radiogroup", slide }) as Seg;

describe("Segmented slide (Kev, 2026-10-13: Open | Premium switches like a pill)", () => {
  it("tells the stylesheet how many choices there are and which one the thumb sits under", () => {
    expect(mount("free", true).props.style).toEqual({ "--kit-seg-n": 2, "--kit-seg-i": 0 });
    expect(mount("premium", true).props.style).toEqual({ "--kit-seg-n": 2, "--kit-seg-i": 1 });
    expect(mount("premium", true).props.className).toBe("kit-seg kit-focus kit-seg--slide");
  });

  it("the plain control (kinds, tabs) carries no thumb", () => {
    const plain = mount("premium");
    expect(plain.props.className).toBe("kit-seg kit-focus");
    expect(plain.props.style).toBeUndefined();
  });
});
