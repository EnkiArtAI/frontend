import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { getQueryFn } from "@/lib/queryClient";

/* What a prompt the viewer may not open looks like (plan §5 #37): the read
   answers 404 and the view says so, with a way back. The model's wallet,
   access and queue hooks are not needed for that and are stubbed; the
   layout is a marker. */
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({ access: "ok", role: "beta" }) }));
vi.mock("@/hooks/useViewerWallets", () => ({ useViewerWallets: () => ({ userKey: null, payer: null }) }));
vi.mock("@/hooks/useRenderQueue", () => ({ useRenderQueue: () => ({}) }));
vi.mock("@/components/image-view/ImageViewDesktop", () => ({ default: function ImageViewDesktop() { return null; } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
const status = vi.hoisted(() => ({ now: "gone" }));
vi.mock("@/components/image-view/useImageViewModel", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useImageViewModel: () => ({ status: status.now, title: "Harbour at dusk", reload: () => {} }),
}));

const { loadState } = await import("@/components/image-view/useImageViewModel");
const { default: ImageView } = await import("@/components/image-view/ImageView");
const { default: ImageViewDesktop } = await import("@/components/image-view/ImageViewDesktop");

afterEach(() => vi.unstubAllGlobals());

/** The read's error as the app's default fetcher throws it for this answer. */
async function readError(status: number): Promise<Error> {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "not found" }), { status }));
  try {
    await getQueryFn({ on401: "throw" })({ queryKey: ["/api/prompts/p-1"] } as never);
  } catch (e) {
    return e as Error;
  }
  throw new Error("the read did not fail");
}

describe("the prompt read's state", () => {
  it("is gone when the prompt answers 404, as the default fetcher reports it", async () => {
    expect(loadState({ isPending: false, error: await readError(404) })).toBe("gone");
  });

  it("is a failure, not gone, on any other error", async () => {
    expect(loadState({ isPending: false, error: await readError(500) })).toBe("failed");
    expect(loadState({ isPending: false, error: new Error("4040: odd") })).toBe("failed");
  });

  it("is loading, then ready", () => {
    expect(loadState({ isPending: true, error: null })).toBe("loading");
    expect(loadState({ isPending: false, error: null })).toBe("ready");
  });
});

/** Renders a tree of plain function components and lists its text. */
function texts(node: ReactNode): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  if (typeof node.type === "function") return texts((node.type as (p: object) => ReactNode)(node.props));
  return texts(node.props.children);
}
function buttons(node: ReactNode): ReactElement<{ onClick: () => void; children: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  if (typeof node.type === "function") return buttons((node.type as (p: object) => ReactNode)(node.props));
  const own = node.type === "button" ? [node as ReactElement<{ onClick: () => void; children: ReactNode }>] : [];
  return [...own, ...buttons(node.props.children)];
}

describe("the view", () => {
  it("says a prompt it may not open isn't available, and offers the way back", () => {
    status.now = "gone";
    const onClose = vi.fn();
    const tree = ImageView({ seed: { promptId: "p-1" }, onClose });
    expect(texts(tree)).toContain("This prompt isn't available");
    const back = buttons(tree).find((b) => b.props.children === "Back");
    back?.props.onClick();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers a retry when the read failed for another reason", () => {
    status.now = "failed";
    const tree = ImageView({ seed: { promptId: "p-1" }, onClose: () => {} });
    expect(texts(tree)).toContain("Couldn't load this prompt");
    expect(texts(tree)).not.toContain("This prompt isn't available");
    expect(buttons(tree).map((b) => b.props.children)).toContain("Try again");
  });

  it("shows the layout once the prompt is in", () => {
    status.now = "ready";
    expect((ImageView({ seed: { promptId: "p-1" } }) as ReactElement).type).toBe(ImageViewDesktop);
  });
});
