import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { QueryClient, type QueryKey, type QueryFunctionContext } from "@tanstack/react-query";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";
import type { BookmarkIndex, Membership } from "../bookmark-index";

const state = vi.hoisted(() => ({ client: null as QueryClient | null, owner: "account-a" as string | null, access: "ok", role: "beta", mode: "hook", slot: 0, query: null as { queryKey: QueryKey; enabled: boolean; queryFn: (context: QueryFunctionContext) => Promise<BookmarkIndex> } | null }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(v: T | (() => T)) => {
    const slot = state.slot++;
    const value = state.mode === "header" && slot === 0 ? { top: 0, bottom: 20, right: 30, left: 0 }
      : state.mode === "picker" && slot === 0 ? [{ id: "category", name: "Portraits", count: 1 }]
      : typeof v === "function" ? (v as () => T)() : v;
    return [value, vi.fn()];
  },
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: <T>(v: T) => ({ current: v }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => state.client,
  useQuery: (query: NonNullable<typeof state.query>) => {
    state.query = query;
    return { data: state.client!.getQueryData(query.queryKey) };
  },
}));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({ access: state.access, role: state.role, userId: state.owner }) }));
vi.mock("@/hooks/useBookmarks", () => ({ listCategories: vi.fn(), listBookmarks: vi.fn(), addBookmark: vi.fn(async () => ({ id: "added" })), removeBookmark: vi.fn(async () => {}), createCategory: vi.fn(), bookmarksProblem: () => "Unavailable" }));
vi.mock("@/components/image-view/useImageViewModel", () => ({ copyText: vi.fn() }));
vi.mock("@/components/ReportButton", () => ({ ReportButton: () => null }));
import { listCategories, listBookmarks } from "@/hooks/useBookmarks";
import { useBookmarkIndex } from "@/hooks/useBookmarkIndex";
import ComposerHeader from "@/components/image-view/ComposerHeader";
import BookmarkPicker from "@/components/enki/BookmarkPicker";

function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const a: BookmarkIndex = new Map([["prompt", [{ bookmarkId: "existing", categoryId: "category" }]]]);
beforeEach(() => { state.client = new QueryClient(); state.owner = "account-a"; state.access = "ok"; state.role = "beta"; state.mode = "hook"; state.slot = 0; vi.clearAllMocks(); vi.stubGlobal("window", { setTimeout: vi.fn() }); });
afterEach(() => { state.client!.clear(); vi.unstubAllGlobals(); });
const useCacheKey = () => { useBookmarkIndex(true); return state.query!.queryKey; };

describe("the session's existing bookmarks", () => {
  it("switches accounts without reusing another account's index", () => {
    const first = useCacheKey(); state.client!.setQueryData(first, a);
    expect(useBookmarkIndex(true)?.has("prompt")).toBe(true);
    state.owner = "account-b";
    expect(useBookmarkIndex(true)?.has("prompt")).not.toBe(true);
    expect(state.query!.queryKey).not.toEqual(first);
  });
  it("does not expose a cached index after sign-out or team-cookie browsing", () => {
    const first = useCacheKey(); state.client!.setQueryData(first, a);
    state.access = "denied"; expect(useBookmarkIndex(true)).toBeUndefined();
    state.access = "ok"; state.role = "team"; expect(useBookmarkIndex(true)).toBeUndefined();
  });
});

describe("the image header's bookmark picker", () => {
  it("passes existing memberships so a saved category is removed rather than added again", () => {
    state.mode = "header";
    const model = { blank: false, guest: false, promptId: "prompt", title: "Portrait", discussion: {}, main: null, saved: true, memberships: a.get("prompt"), bookmarked: vi.fn() } as unknown as ImageViewModel;
    const picker = [...walk(ComposerHeader({ model, onBack: vi.fn() }))].find((n) => n.type === BookmarkPicker)!;
    expect(picker.props.memberships).toEqual(a.get("prompt"));
  });
  it("a successful removal updates the same cache observed by the header", async () => {
    const key = useCacheKey(); state.client!.setQueryData(key, a);
    state.mode = "picker"; state.slot = 0;
    const tree = BookmarkPicker({ promptId: "prompt", memberships: a.get("prompt"), onClose: vi.fn() });
    const category = [...walk(tree)].find((n) => n.type === "button" && n.props.title === "Remove from Portraits")!;
    await (category.props.onClick as () => Promise<void>)();
    state.mode = "hook";
    expect(useBookmarkIndex(true)?.has("prompt")).toBe(false);
  });
});


describe("confirmed changes while the index loads", () => {
  const clickCategory = async (memberships?: readonly Membership[]) => {
    state.mode = "picker"; state.slot = 0;
    const tree = BookmarkPicker({ promptId: "prompt", memberships, onClose: vi.fn() });
    const category = [...walk(tree)].find((n) => n.type === "button" && n.props["aria-pressed"] !== undefined)!;
    await (category.props.onClick as () => Promise<void>)();
  };
  it("records an add before the initial read and asks to complete the index", async () => {
    const key = useCacheKey();
    await clickCategory();
    expect(state.client!.getQueryData<BookmarkIndex>(key)?.get("prompt")).toEqual([{ bookmarkId: "added", categoryId: "category" }]);
    expect(state.client!.getQueryState(key)?.isInvalidated).toBe(true);
  });
  it("cancels an older read so it cannot restore a removed bookmark", async () => {
    const key = useCacheKey(); state.client!.setQueryData(key, a);
    let finish!: (index: BookmarkIndex) => void;
    const reading = state.client!.fetchQuery({ queryKey: key, staleTime: 0, queryFn: () => new Promise<BookmarkIndex>((resolve) => { finish = resolve; }) }).catch(() => undefined);
    await clickCategory(a.get("prompt"));
    finish(a); await reading;
    expect(state.client!.getQueryData<BookmarkIndex>(key)?.has("prompt")).toBe(false);
  });
  it("removes one category without losing the other saved membership", async () => {
    const key = useCacheKey();
    const second = { bookmarkId: "second", categoryId: "other-category" };
    state.client!.setQueryData(key, new Map([["prompt", [...a.get("prompt")!, second]]]));
    await clickCategory(a.get("prompt"));
    expect(state.client!.getQueryData<BookmarkIndex>(key)?.get("prompt")).toEqual([second]);
  });
  it("does not change another account's cache", async () => {
    const keyA = useCacheKey(); state.client!.setQueryData(keyA, a);
    state.owner = "account-b";
    const keyB = useCacheKey(); state.client!.setQueryData(keyB, a);
    await clickCategory(a.get("prompt"));
    expect(state.client!.getQueryData<BookmarkIndex>(keyA)?.has("prompt")).toBe(true);
    expect(state.client!.getQueryData<BookmarkIndex>(keyB)?.has("prompt")).toBe(false);
  });
});


it("cancels the initial transport when the account query is cancelled", async () => {
  const key = useCacheKey();
  let signal: AbortSignal | undefined;
  vi.mocked(listCategories).mockImplementationOnce((s) => {
    signal = s;
    return new Promise((resolve) => s?.addEventListener("abort", () => resolve([])));
  });
  const reading = state.client!.fetchQuery({ queryKey: key, queryFn: state.query!.queryFn }).catch(() => undefined);
  expect(signal?.aborted).toBe(false);
  await state.client!.cancelQueries({ queryKey: key, exact: true });
  await reading;
  expect(signal?.aborted).toBe(true);
  expect(listBookmarks).not.toHaveBeenCalled();
  expect(state.client!.getQueryData(key)).toBeUndefined();
});
