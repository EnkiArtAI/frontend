/**
 * The decisions behind the kit controls (components/kit), kept apart from the
 * components so they are tested as behaviour rather than pinned as text.
 */
import { RESOLUTION_TIERS } from "@/lib/generation/resolution";
import { TABS } from "./breakpoints";

/** A press this soon after the last accepted one is the second half of a
    double click, and would pay for a second render. Deliberate repeats are
    slower and still queue. */
export const PRESS_GAP_MS = 350;

export function acceptPress(lastAccepted: number | null, now: number): boolean {
  return lastAccepted === null || now - lastAccepted >= PRESS_GAP_MS;
}

/** Sheet below 1024 px, popover above, asked when the menu opens: render
    output never depends on a media query, so nothing flashes on hydration. */
export function menuMode(win: Pick<Window, "matchMedia">): "sheet" | "popover" {
  return win.matchMedia(TABS).matches ? "sheet" : "popover";
}

/** A popover keeps this far from both viewport edges: never wider than
    `100vw - 40px` (handoff §0). */
export const MENU_EDGE = 20;

export interface MenuPlace {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Where an open popover goes, from its trigger and its measured size. A menu
 * in a bottom bar asks for "up"; without a side it takes the one that holds
 * the list, else the roomier one, and scrolls inside itself. Horizontally it
 * starts at the trigger and moves left as far as it must to stay inside.
 */
export function placeMenu(
  trigger: { left: number; top: number; bottom: number },
  panel: { width: number; height: number },
  view: { width: number; height: number },
  direction?: "up" | "down",
): MenuPlace {
  const below = view.height - trigger.bottom - 8;
  const above = trigger.top - 8;
  const up = direction ? direction === "up" : below < panel.height && above > below;
  return {
    left: Math.max(MENU_EDGE, Math.min(trigger.left, view.width - MENU_EDGE - panel.width)),
    top: up ? undefined : trigger.bottom + 4,
    bottom: up ? view.height - trigger.top + 4 : undefined,
    maxHeight: Math.max(90, up ? above : below),
  };
}

/** Every tier on the ladder. The ones above the model's ceiling stay listed,
    disabled, and say why; `subs` (the caller's server quotes) align with
    `allowed`. */
export function tierOptions(allowed: readonly string[], model: string, subs: ReadonlyArray<string | null>) {
  return RESOLUTION_TIERS.map((t) => {
    const i = allowed.indexOf(t);
    return i < 0
      ? { key: t, label: t, sub: `not on ${model}`, disabled: true }
      : { key: t, label: t, sub: subs[i] };
  });
}

/** A drag on the sheet's handle further down than this closes it. */
export const SHEET_DRAG_CLOSE = 60;

export const sheetDragCloses = (dy: number) => dy > SHEET_DRAG_CLOSE;

/** The focus trap's next stop among `count` focusable elements: Tab wraps
    last → first, Shift+Tab first → last, and from outside the list focus
    enters at the near end. */
export function trapStep(at: number, count: number, back: boolean): number {
  const from = at < 0 ? (back ? 0 : count - 1) : at;
  return (from + (back ? count - 1 : 1)) % count;
}

let locks = 0;
let unlockPage = () => {};

/**
 * Locks page scrolling while a sheet is up, without a scrollbar flash: the
 * scrollbar's width comes back as padding, so the page keeps its width to the
 * pixel (handoff §3). Nested locks count and the last release restores what
 * was there. Returns the release, which only ever counts once.
 */
export function lockScroll(root: HTMLElement, viewportWidth: number): () => void {
  if (locks++ === 0) {
    const { overflow, paddingRight } = root.style;
    const bar = viewportWidth - root.clientWidth;
    root.style.overflow = "hidden";
    if (bar > 0) root.style.paddingRight = `${bar}px`;
    unlockPage = () => {
      root.style.overflow = overflow;
      root.style.paddingRight = paddingRight;
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks === 0) unlockPage();
  };
}

/**
 * [Add funds] everywhere (R29): the shell's billing panel when the shell
 * takes the event (EnkiHome calls preventDefault), else Settings › Payment in
 * a new tab, so a render queue on this page survives.
 */
export function openAddFunds(): void {
  if (window.dispatchEvent(new Event("enki:open-billing", { cancelable: true }))) {
    window.open("/settings?tab=payment", "_blank", "noopener");
  }
}
