import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { EnkiPrompt } from "@/lib/enkiPromptAdapter";
const edit = vi.hoisted(() => ({ push: vi.fn(), wallet: true, access: "ok", role: "beta", id: "22222222-2222-4222-8222-222222222222", handle: "qa" as string | null, queries: [] as Array<{queryKey: unknown[]; enabled: boolean; queryFn: () => Promise<unknown>}> }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(v: T | (() => T)) => [typeof v === "function" ? (v as () => T)() : v, vi.fn()],
  useEffect: () => {}, useMemo: <T>(f: () => T) => f(), useRef: <T>(v: T) => ({ current: v }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: (query: typeof edit.queries[number]) => { edit.queries.push(query); return { data: query.enabled ? { prompts: [{ id: edit.id, title: "Portrait" }] } : undefined, isError: false }; } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: edit.push }), useSearchParams: () => new URLSearchParams() }));
vi.mock("thirdweb/react", () => ({ useActiveAccount: () => null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ publicKey: null }) }));
vi.mock("@/hooks/useCdpAddress", () => ({ useCdpAddress: () => ({ address: null }) }));
vi.mock("@/hooks/useSolanaAuth", () => ({ useSolanaAuth: () => ({ isAuthenticated: edit.wallet, walletAddress: edit.wallet ? "local-fixture-wallet" : null }) }));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({ access: edit.access, role: edit.role, userId: "account-fixture-1", profile: { handle: edit.handle, bio: null, avatarUrl: null, coverUrl: null } }) }));
vi.mock("@/components/enki/EnkiCard", () => ({ default: () => null }));
vi.mock("@/components/enki/EnkiDetailPanel", () => ({ default: () => null }));
vi.mock("@/components/ReportButton", () => ({ ReportButton: () => null }));

import ProfileView from "@/components/profile/ProfileView";
import EnkiCard from "@/components/enki/EnkiCard";
function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const cards = (foreign = false) => [...walk(ProfileView(foreign ? { handle: "other", isOwnProfile: false } : {}))].filter((el) => el.type === EnkiCard);
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { edit.push.mockClear(); edit.wallet = true; edit.access = "ok"; edit.role = "beta"; edit.queries = []; edit.handle = "qa"; edit.id = "22222222-2222-4222-8222-222222222222"; });
describe("the profile's released-prompt pencil", () => {
  it("routes to the stored prompt id, so the editor loads fresh owner-authorized data", () => {
    const card = cards()[0];
    (card.props.onEdit as (p: EnkiPrompt) => void)(card.props.prompt as EnkiPrompt);
    expect(edit.push).toHaveBeenCalledWith(`/editor?id=${edit.id}`);
  });
  it("encodes the id as one query parameter", () => {
    edit.id = "p/a?b=c&d=e#f";
    const card = cards()[0];
    (card.props.onEdit as (p: EnkiPrompt) => void)(card.props.prompt as EnkiPrompt);
    const url = new URL(edit.push.mock.calls[0][0], "https://local.example");
    expect(url.pathname).toBe("/editor");
    expect([...url.searchParams]).toEqual([["id", edit.id]]); expect(url.hash).toBe("");
  });
  it("offers no edit action on a foreign profile", () => {
    const foreign = cards(true);
    expect(foreign).toHaveLength(1); expect(foreign[0].props.onEdit).toBeUndefined();
    expect(edit.push).not.toHaveBeenCalled();
  });
});


describe("the Released shelf behind the pencil", () => {
  it("reads only the own creator's prompts, never the public feed", async () => {
    const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({prompts: []})));
    vi.stubGlobal("fetch", fetcher); cards();
    await edit.queries.at(-1)!.queryFn();
    const url = new URL(fetcher.mock.calls[0][0] as string, "https://local.example");
    expect(url.searchParams.get("creator")).toBe("qa");
  });
  it("uses the viewed creator for a foreign profile", async () => {
    const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({prompts: []})));
    vi.stubGlobal("fetch", fetcher); cards(true);
    await edit.queries.at(-1)!.queryFn();
    const url = new URL(fetcher.mock.calls[0][0] as string, "https://local.example");
    expect(url.searchParams.get("creator")).toBe("other");
  });
  it("waits for the own handle and never falls back to the public feed", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    edit.handle = null; expect(cards()).toHaveLength(0);
    const query = edit.queries.at(-1)!;
    expect(query.enabled).toBe(false);
    expect(await query.queryFn()).toEqual({prompts: []});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keys the Released list by the current creator when accounts change", () => {
    cards(); const first = edit.queries.at(-1)!.queryKey;
    edit.handle = "second"; cards();
    expect(edit.queries.at(-1)!.queryKey).not.toEqual(first);
    expect(edit.queries.at(-1)!.queryKey.at(-1)).toBe("second");
  });
});

describe("a signed-in account without a wallet", () => {
  it("can see its Released shelf and editor action", () => { edit.wallet = false; expect(cards()).toHaveLength(1); });
  it("team-cookie browsing does not stand in for an account", () => { edit.wallet = false; edit.role = "team"; expect(cards()).toHaveLength(0); });
  it("a denied session is still a guest", () => { edit.wallet = false; edit.access = "denied"; expect(cards()).toHaveLength(0); });
});
