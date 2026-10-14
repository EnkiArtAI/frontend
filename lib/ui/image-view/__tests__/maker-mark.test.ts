import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

/** The mark's link opens the maker's profile the shell way (openCreator); a name without a handle, and You, open nothing. */
const open = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openCreator", () => ({ openCreator: open }));

import MakerMark from "@/components/image-view/MakerMark";

type Props = { onClick?: () => void; className?: string; children?: unknown; title?: string };
const draw = (maker: Parameters<typeof MakerMark>[0]["maker"]) => MakerMark({ maker }) as ReactElement<Props> | null;

describe("MakerMark", () => {
  it("opens the handle's profile on click, with the handle alone", () => {
    const el = draw({ handle: "ada", name: "Ada", mine: false })!;
    expect(el.type).toBe("button");
    expect(el.props.title).toBe("Open @ada's profile");
    el.props.onClick!();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("ada");
  });

  it("is a plain span for a name without a handle and for You, and nothing for nobody", () => {
    expect(draw({ handle: null, name: "Bea", mine: false })!.type).toBe("span");
    expect(draw({ handle: "me", name: null, mine: true })!.type).toBe("span");
    expect(draw({ handle: "me", name: null, mine: true })!.props.children).toBe("You");
    expect(draw(undefined)).toBeNull();
  });
});
