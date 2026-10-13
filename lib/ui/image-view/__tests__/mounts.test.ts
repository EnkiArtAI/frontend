import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

/* The places a prompt opens (plan §2.2) each load the Image View through
   next/dynamic, client-only. dynamic is replaced by a recorder that hands
   back a marker component, so each mount's tree can be searched for it.
   /generator/[id] no longer mounts the view: it goes on to the feed with
   the view over it, beside the menu (Kev, 2026-10-13; shell-prompt-links). */
type Loaded = { loader: () => Promise<{ default: unknown }>; options: { ssr?: boolean }; View: () => null };
const loaded = vi.hoisted(() => [] as Loaded[]);
vi.mock("next/dynamic", () => ({
  default: (loader: Loaded["loader"], options: Loaded["options"]) => {
    const View = () => null;
    loaded.push({ loader, options, View });
    return View;
  },
}));
vi.mock("@/components/image-view/ImageView", () => ({ default: function ImageView() { return null; } }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "p-42" }) }));
// The mounts run as plain functions: state is its first value, effects do not run.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: <T>(v: T | (() => T)) => [typeof v === "function" ? (v as () => T)() : v, () => {}],
  useEffect: () => {},
}));

const mount = async <M extends { default: unknown }>(load: () => Promise<M>) => {
  const before = loaded.length;
  const mod = await load();
  return { Mount: mod.default as (props: never) => ReactNode, dyn: loaded.slice(before) };
};
const panel = await mount(() => import("@/components/enki/EnkiDetailPanel"));
const modal = await mount(() => import("@/components/PromptDetailModal"));
const { default: ImageView } = await import("@/components/image-view/ImageView");

/** The elements of a tree, depth first. */
function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) {
    yield node;
    yield* walk(node.props.children as ReactNode);
  }
}
const viewIn = (tree: ReactNode, View: unknown) => [...walk(tree)].find((el) => el.type === View);

describe.each([
  ["the feed and profile panel (EnkiDetailPanel)", panel],
  ["/showcase (PromptDetailModal)", modal],
])("%s", (_name, { dyn }) => {
  it("loads the Image View, and only it, through next/dynamic", async () => {
    expect(dyn).toHaveLength(1);
    expect((await dyn[0].loader()).default).toBe(ImageView);
  });

  it("loads it client-only, so a phone never paints the desktop layout first", () => {
    expect(dyn[0].options.ssr).toBe(false);
  });
});

describe("what each mount hands the view", () => {
  it("the panel: the card's seed and its close, inside the frame", () => {
    const seed = { promptId: "p-1", title: "Harbour at dusk" };
    const onClose = () => {};
    const tree = (panel.Mount as (p: object) => ReactElement<{ className: string }>)({ seed, onClose });
    expect(tree.props.className).toBe("iv-frame");
    expect(viewIn(tree, panel.dyn[0].View)?.props).toMatchObject({ seed, onClose });
  });

  it("the panel: the launcher's blank composer", () => {
    const tree = (panel.Mount as (p: object) => ReactNode)({ seed: "blank", onClose: () => {} });
    expect(viewIn(tree, panel.dyn[0].View)?.props.seed).toBe("blank");
  });

  it("the modal: the prompt's id and its close, inside the frame", () => {
    const onClose = () => {};
    const prompt = { id: "p-7", title: "Night market", artist: "Mara", imageUrl: "https://cdn.example/a.png" };
    const tree = (modal.Mount as (p: object) => ReactElement<{ className: string }>)({ isOpen: true, onClose, prompt });
    expect(tree.props.className).toBe("iv-frame");
    const props = viewIn(tree, modal.dyn[0].View)?.props;
    expect(props).toMatchObject({ onClose, seed: { promptId: "p-7", title: "Night market" } });
  });
});
