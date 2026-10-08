import { describe, it, expect, vi, afterEach } from "vitest";
import {
  acceptPress, menuMode, placeMenu, tierOptions, sheetDragCloses, trapStep, lockScroll, openAddFunds,
} from "../controls";
import { TABS } from "../breakpoints";

describe("acceptPress (Generate's double-press guard)", () => {
  it("takes the first press and any press 350 ms or more after the last accepted one", () => {
    expect(acceptPress(null, 5)).toBe(true);
    expect(acceptPress(1000, 1349)).toBe(false);
    expect(acceptPress(1000, 1350)).toBe(true);
  });
});

describe("menuMode", () => {
  it("asks the TABS query when the menu opens: a sheet below 1024 px, a popover above", () => {
    const asked: string[] = [];
    const win = (narrow: boolean) => ({
      matchMedia: (q: string) => { asked.push(q); return { matches: narrow && q === TABS } as MediaQueryList; },
    });
    expect(menuMode(win(true))).toBe("sheet");
    expect(menuMode(win(false))).toBe("popover");
    expect(asked).toEqual([TABS, TABS]);
  });
});

describe("placeMenu", () => {
  const view = { width: 1280, height: 800 };
  const barPill = { left: 100, top: 740, bottom: 774 };
  const topPill = { left: 100, top: 60, bottom: 94 };

  it("opens upward from a pill in a bottom bar, the full space above it as its limit", () => {
    expect(placeMenu(barPill, { width: 240, height: 200 }, view)).toEqual({ left: 100, bottom: 64, maxHeight: 732 });
  });

  it("opens downward where the list fits below", () => {
    expect(placeMenu(topPill, { width: 240, height: 200 }, view)).toEqual({ left: 100, top: 98, maxHeight: 698 });
  });

  it("follows an asked side even where the other side has more room", () => {
    expect(placeMenu(topPill, { width: 240, height: 200 }, view, "up")).toEqual({ left: 100, bottom: 744, maxHeight: 90 });
    expect(placeMenu(barPill, { width: 240, height: 200 }, view, "down").top).toBe(778);
  });

  it("stays inside 20 px of each edge: at 360 px a menu too wide starts at 20 (its CSS cuts it to 320)", () => {
    const phone = { width: 360, height: 640 };
    expect(placeMenu({ left: 250, top: 580, bottom: 614 }, { width: 400, height: 150 }, phone).left).toBe(20);
    expect(placeMenu({ left: 250, top: 580, bottom: 614 }, { width: 270, height: 150 }, phone).left).toBe(70);
    expect(placeMenu({ left: 4, top: 580, bottom: 614 }, { width: 200, height: 150 }, phone).left).toBe(20);
  });
});

describe("tierOptions", () => {
  it("lists every tier and disables the ones above the model's ceiling, saying why", () => {
    expect(tierOptions(["1K", "2K"], "Flux", ["$0.00", null])).toEqual([
      { key: "1K", label: "1K", sub: "$0.00" },
      { key: "2K", label: "2K", sub: null },
      { key: "4K", label: "4K", sub: "not on Flux", disabled: true },
    ]);
  });
});

describe("the sheet's handle", () => {
  it("closes on a drag of more than 60 px", () => {
    expect(sheetDragCloses(60)).toBe(false);
    expect(sheetDragCloses(61)).toBe(true);
  });
});

describe("trapStep", () => {
  it("wraps Tab from last to first and Shift+Tab from first to last", () => {
    expect(trapStep(1, 3, false)).toBe(2);
    expect(trapStep(2, 3, false)).toBe(0);
    expect(trapStep(1, 3, true)).toBe(0);
    expect(trapStep(0, 3, true)).toBe(2);
  });

  it("enters at the near end from outside the list", () => {
    expect(trapStep(-1, 3, false)).toBe(0);
    expect(trapStep(-1, 3, true)).toBe(2);
  });
});

describe("lockScroll", () => {
  const page = (clientWidth: number) =>
    ({ clientWidth, style: { overflow: "auto", paddingRight: "1px" } }) as unknown as HTMLElement;

  it("gives the scrollbar's width back as padding, so the page keeps its width", () => {
    const root = page(990);
    const release = lockScroll(root, 1000);
    expect(root.style.overflow).toBe("hidden");
    expect(root.style.paddingRight).toBe("10px");
    release();
    expect(root.style.overflow).toBe("auto");
    expect(root.style.paddingRight).toBe("1px");
  });

  it("adds no padding when there is no scrollbar", () => {
    const root = page(1000);
    const release = lockScroll(root, 1000);
    expect(root.style.paddingRight).toBe("1px");
    release();
  });

  it("holds while any lock is held, and a release counts only once", () => {
    const root = page(990);
    const first = lockScroll(root, 1000);
    const second = lockScroll(root, 1000);
    first();
    first();
    expect(root.style.overflow).toBe("hidden");
    second();
    expect(root.style.overflow).toBe("auto");
  });
});

describe("openAddFunds", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (consume: boolean) => {
    const win = Object.assign(new EventTarget(), { open: vi.fn() });
    if (consume) win.addEventListener("enki:open-billing", (e) => e.preventDefault());
    vi.stubGlobal("window", win);
    return win;
  };

  it("leaves it to the shell when the shell takes the event", () => {
    const win = stub(true);
    openAddFunds();
    expect(win.open).not.toHaveBeenCalled();
  });

  it("opens Settings › Payment in a new tab where no shell listens", () => {
    const win = stub(false);
    openAddFunds();
    expect(win.open).toHaveBeenCalledWith("/settings?tab=payment", "_blank", "noopener");
  });
});
