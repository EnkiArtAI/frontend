import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { EnkiPrompt } from "@/lib/enkiPromptAdapter";
const edit = vi.hoisted(() => ({ push: vi.fn(), id: "22222222-2222-4222-8222-222222222222" }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(v: T | (() => T)) => [typeof v === "function" ? (v as () => T)() : v, vi.fn()],
  useEffect: () => {}, useMemo: <T>(f: () => T) => f(), useRef: <T>(v: T) => ({ current: v }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { prompts: [{ id: edit.id, title: "Portrait" }] }, isError: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: edit.push }), useSearchParams: () => new URLSearchParams() }));
vi.mock("thirdweb/react", () => ({ useActiveAccount: () => null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ publicKey: null }) }));
vi.mock("@/hooks/useCdpAddress", () => ({ useCdpAddress: () => ({ address: null }) }));
vi.mock("@/hooks/useSolanaAuth", () => ({ useSolanaAuth: () => ({ isAuthenticated: true, walletAddress: "local-fixture-wallet" }) }));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({ profile: { handle: "qa", bio: null, avatarUrl: null, coverUrl: null } }) }));
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
beforeEach(() => { edit.push.mockClear(); edit.id = "22222222-2222-4222-8222-222222222222"; });
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
