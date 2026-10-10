import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ImageViewModel, Shot } from "@/components/image-view/useImageViewModel";

const ui = vi.hoisted(() => ({ state: [] as unknown[], index: 0, phone: true, model: null as unknown }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "mobile-test",
  useState: <T>(start: T) => {
    const i = ui.index++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => ui.phone }));
vi.mock("@/components/image-view/useImageViewModel", () => ({ useImageViewModel: () => ui.model }));
vi.mock("@/components/image-view/ImageViewDesktop", () => ({ default: () => null }));
vi.mock("@/components/enki/NftPickerModal", () => ({ default: () => null }));
vi.mock("@/components/generation/BoostToggle", () => ({ default: () => null }));
vi.mock("@/components/kit/AddFundsPopover", () => ({ default: () => null }));
vi.mock("@/components/kit/CostLine", () => ({ default: () => null }));
vi.mock("@/components/kit/FullscreenViewer", () => ({ default: () => null }));
vi.mock("@/components/kit/GenerateButton", () => ({ default: () => null }));
vi.mock("@/components/kit/GeneratorPill", () => ({ default: () => null }));
vi.mock("@/components/kit/JobTile", () => ({ default: () => null }));
vi.mock("@/components/kit/ReferenceTiles", () => ({ default: () => null }));
vi.mock("@/components/kit/SettingsPills", () => ({ RatioPill: () => null, ResolutionPill: () => null, QualityPill: () => null }));
vi.mock("@/components/image-view/AgentRow", () => ({ default: () => null }));
vi.mock("@/components/image-view/ComposerHeader", () => ({ default: () => null }));
vi.mock("@/components/image-view/Discussion", () => ({ default: () => null }));
vi.mock("@/components/image-view/MainImage", () => ({ default: () => null }));
vi.mock("@/components/image-view/PromptPanel", () => ({ default: () => null }));
vi.mock("@/components/image-view/ViewerPanel", () => ({ default: () => null }));

import ImageView from "@/components/image-view/ImageView";
import ImageViewDesktop from "@/components/image-view/ImageViewDesktop";
import ImageViewMobile from "@/components/image-view/ImageViewMobile";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import GenerateButton from "@/components/kit/GenerateButton";
import JobTile from "@/components/kit/JobTile";
import ViewerPanel from "@/components/image-view/ViewerPanel";
import MainImage from "@/components/image-view/MainImage";

function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const ofType = (tree: ReactNode, type: unknown) => [...walk(tree)].filter((el) => el.type === type);
let model: ImageViewModel;
const draw = () => { ui.index = 0; return ImageViewMobile({ model, onClose: vi.fn() }); };
const press = (element: ReactElement<Record<string, unknown>>) => (element.props.onClick as () => void)();
const tab = (tree: ReactNode, name: string) => [...walk(tree)].find((el) => el.props.role === "tab" && String(el.props.children).startsWith(name))!;
const shot = (id: string, status: "ready" | "failed" | "rendering"): Shot => ({
  key: `job:${id}`, kind: "job", ratio: "4:5", src: status === "ready" ? "/fixture.png" : undefined,
  job: { id, status, seen: false } as Shot["job"],
});
beforeEach(() => {
  ui.state = []; ui.index = 0; ui.phone = true;
  model = {
    status: "ready", blank: false, guest: false, premium: false, promptId: "prompt", title: "Portrait", now: 0,
    queue: [], jobs: [], finished: [], history: [], examples: [], community: [], main: null,
    discussion: { data: undefined }, core: { entry: null, supportsQuality: false, boostAvailable: false, boostAt: () => false },
    refs: [], cap: 0, over: 0, pending: 0, models: [], modelPrices: [], button: { label: "Generate", dimmed: false },
    chip: "$0.20", quotePending: false, balance: null, funds: null,
    historyState: { loading: false, failed: false, more: false, retry: vi.fn(), loadOlder: vi.fn() },
    select: vi.fn(), seen: vi.fn(), generate: vi.fn(), again: vi.fn(),
  } as unknown as ImageViewModel;
  ui.model = model;
});

describe("the phone Image View", () => {
  it("chooses the phone layout with the same model, and keeps desktop above the breakpoint", () => {
    expect(ImageView({ seed: "blank" }).type).toBe(ImageViewMobile);
    ui.phone = false;
    expect(ImageView({ seed: "blank" }).type).toBe(ImageViewDesktop);
  });
  it("shows four creator examples as the opening grid", () => {
    model.examples = Array.from({length: 4}, (_, i) => ({ key: 'example:' + i, kind: 'example', src: '/example' + i + '.png', ratio: '4:5' } as Shot));
    model.finished = model.examples;
    const grid = [...walk(draw())].find((el) => el.props.className === 'iv-mobile-examples')!;
    expect([...walk(grid)].filter((el) => el.type === 'button')).toHaveLength(4);
  });
  it("keeps a single example on the aspect-preserving main stage", () => {
    model.examples = [{ key: 'example:0', kind: 'example', src: '/example.png', ratio: '4:5' }];
    expect(ofType(draw(), MainImage)).toHaveLength(1);
    expect([...walk(draw())].some((el) => el.props.className === 'iv-mobile-examples')).toBe(false);
  });
  it("uses the model's existing Generate guard and server quote chip", () => {
    const generate = ofType(draw(), GenerateButton)[0];
    expect(generate.props.chip).toBe("$0.20");
    expect(generate.props.onPress).toBe(model.generate);
  });
  it("opens failed jobs with their setup in the existing Retry panel", () => {
    const failed = shot("f", "failed"); model.queue = [failed];
    press(ofType(draw(), JobTile)[0]);
    const viewer = ofType(draw(), FullscreenViewer)[0];
    expect(viewer.props).toMatchObject({ layout: "stacked", nav: "dots", index: 0 });
    expect(viewer.props.items).toMatchObject([{ key: failed.key, failed: { message: expect.any(String) } }]);
    expect((viewer.props.panel as ReactElement).type).toBe(ViewerPanel);
    expect((viewer.props.panel as ReactElement<{ shot: Shot }>).props.shot).toBe(failed);
    expect(model.again).not.toHaveBeenCalled();
  });
  it("marks a ready job seen without moving it into History when its viewer closes", () => {
    const ready = shot("r", "ready"); model.queue = [ready]; model.finished = [ready];
    press(ofType(draw(), JobTile)[0]);
    const viewer = ofType(draw(), FullscreenViewer)[0];
    (viewer.props.onClose as (last: number) => void)(0);
    expect(model.seen).toHaveBeenCalledWith(ready);
    expect(model.select).toHaveBeenCalledWith(ready);
    expect(model.queue).toEqual([ready]); expect(model.history).toEqual([]);
    expect(ofType(draw(), FullscreenViewer)).toHaveLength(0);
  });
  it("shows a rendering job on the stage without opening a finished-image viewer", () => {
    const pending = shot("p", "rendering"); model.queue = [pending];
    press(ofType(draw(), JobTile)[0]);
    expect(model.select).toHaveBeenCalledWith(pending);
    expect(ofType(draw(), FullscreenViewer)).toHaveLength(0);
  });
  it("loads a history selection through the model and returns to its composer", () => {
    const history = { key: "history:h", kind: "history", ratio: "4:5", thumb: "/h.png" } as Shot;
    model.history = [history]; press(tab(draw(), "History"));
    const entry = [...walk(draw())].find((el) => el.props.className === "iv-mobile-hitem")!;
    press(entry); expect(model.select).toHaveBeenCalledWith(history);
    expect(tab(draw(), "Generate").props["aria-selected"]).toBe(true);
  });
  it("never offers another person's History to guests or the blank composer", () => {
    model.guest = true;
    expect([...walk(draw())].filter((el) => el.props.role === "tab")).toHaveLength(2);
    model.blank = true;
    expect([...walk(draw())].filter((el) => el.props.role === "tab")).toHaveLength(1);
  });
});
