import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const shell = vi.hoisted(() => ({ push: vi.fn(), events: [] as string[], scroll: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(v: T | (() => T)) => [typeof v === "function" ? (v as () => T)() : v, vi.fn()],
  useEffect: () => {}, useLayoutEffect: () => {}, useEffectEvent: <T>(f: T) => f,
  useSyncExternalStore: (_subscribe: unknown, _read: unknown, server: () => unknown) => server(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: shell.push }) }));
vi.mock("thirdweb/react", () => ({ useActiveAccount: () => null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ connected: false, disconnect: vi.fn() }) }));
vi.mock("@/providers/ThemeProvider", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
vi.mock("@/hooks/useHoldings", () => ({ useHoldings: () => ({ ready: false, balance: 0 }) }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("@/hooks/useViewerWallets", () => ({ useViewerWallets: () => ({ payer: null }) }));
vi.mock("@/hooks/useEmailAuth", () => ({ useEmailAuth: () => ({ isAuthed: false }) }));
vi.mock("@/hooks/useCdpAddress", () => ({ useCdpAddress: () => ({ address: null }) }));
vi.mock("@/hooks/useSolanaAuth", () => ({ useSolanaAuth: () => ({ isAuthenticated: false }) }));
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({ access: "ok", role: "beta", handle: "qa" }) }));
vi.mock("@/hooks/useRecoveryStatus", () => ({ useRecoveryStatus: () => null }));
vi.mock("@/hooks/useSecondFactor", () => ({ useNeeds2fa: () => false }));
vi.mock("@/hooks/useNotifications", () => ({ useNotifications: () => ({ unseen: 0 }) }));
vi.mock("@/hooks/useMessages", () => ({ useMessages: () => ({ unreadTotal: 0 }) }));
vi.mock("@/components/enki-shell/UsernameOnboard", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/AnalyticsPanel", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/NotificationsPanel", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/MessagesPanel", () => ({ default: () => null }));
vi.mock("@/components/enki/EnkiFeedPage", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/EnkiSidebar", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/BookmarksPanel", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/FeedbackModal", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/EnkiPanel", () => ({ default: () => null }));
vi.mock("@/components/LoginModal", () => ({ default: () => null }));
vi.mock("@/components/settings/SettingsView", () => ({ default: () => null }));
vi.mock("@/components/profile/ProfileView", () => ({ default: () => null }));
vi.mock("../../../../app/leaderboard/page", () => ({ default: () => null }));

import EnkiHome from "@/components/enki-shell/EnkiHome";
import EnkiSidebar from "@/components/enki-shell/EnkiSidebar";

function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) {
    yield node;
    yield* walk(node.props.children as ReactNode);
  }
}
function home() {
  const tree = EnkiHome({ children: null });
  const sidebar = [...walk(tree)].find((el) => el.type === EnkiSidebar)!;
  (sidebar.props.onNav as (id: string) => void)("home");
}
function frame(hidden: boolean) {
  vi.stubGlobal("document", {
    querySelector: (selector: string) => selector === ".iv-frame"
      ? { classList: { contains: (name: string) => hidden && name === "is-hidden" } } : null,
  });
}

beforeEach(() => {
  shell.push.mockClear(); shell.scroll.mockClear(); shell.events.length = 0;
  vi.stubGlobal("window", {
    dispatchEvent: (event: Event) => { shell.events.push(event.type); return true; },
    scrollTo: shell.scroll,
    location: { pathname: "/home" },
  });
  vi.stubGlobal("CustomEvent", class extends Event {});
});
afterEach(() => vi.unstubAllGlobals());

describe("Home is the feed where the reader left it (Kev, 2026-10-13)", () => {
  it("closes a view hidden behind a menu panel, never brings it back, and leaves the feed as it was", () => {
    frame(true); home();
    expect(shell.events).toEqual(["enki:close-detail"]);
    expect(shell.push).not.toHaveBeenCalled();
    expect(shell.scroll).not.toHaveBeenCalled();
  });
  it("from another route it goes home without resetting the feed", () => {
    (window as unknown as { location: { pathname: string } }).location.pathname = "/editor";
    frame(true); home();
    expect(shell.events).toEqual(["enki:close-detail"]);
    expect(shell.push).toHaveBeenCalledWith("/home");
    expect(shell.scroll).not.toHaveBeenCalled();
  });
  it("closes a visible view without resetting the feed", () => {
    frame(false); home();
    expect(shell.events).toEqual(["enki:close-detail"]);
    expect(shell.push).not.toHaveBeenCalled();
    expect(shell.scroll).not.toHaveBeenCalled();
  });
  it("resets the feed only when no view is open", () => {
    vi.stubGlobal("document", { querySelector: () => null }); home();
    expect(shell.events).toEqual(["enki:close-detail", "enki:home"]);
    expect(shell.push).toHaveBeenCalledWith("/home");
    expect(shell.scroll).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});
