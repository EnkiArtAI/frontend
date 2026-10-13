"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTheme } from "../../providers/ThemeProvider";
import { useHoldings } from "@/hooks/useHoldings";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useViewerWallets } from "@/hooks/useViewerWallets";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useSolanaAuth } from "@/hooks/useSolanaAuth";
import { useBetaAccess } from "@/components/BetaGate";
import UsernameOnboard from "./UsernameOnboard";
import AnalyticsPanel from "./AnalyticsPanel";
import NotificationsPanel from "./NotificationsPanel";
import MessagesPanel from "./MessagesPanel";
import { useRecoveryStatus } from "@/hooks/useRecoveryStatus";
import { useNeeds2fa } from "@/hooks/useSecondFactor";
import { useNotifications } from "@/hooks/useNotifications";
import { useMessages } from "@/hooks/useMessages";
import EnkiFeedPage from "@/components/enki/EnkiFeedPage";
import { openLogin } from "@/lib/openLogin";
import { notify } from "@/components/kit/notify";
import { RAIL } from "@/lib/ui/kit/breakpoints";
import { balanceView } from "@/lib/ui/kit/price";
import EnkiSidebar, { type NavItem } from "./EnkiSidebar";
import BookmarksPanel from "./BookmarksPanel";
import FeedbackModal from "./FeedbackModal";
import EnkiPanel from "./EnkiPanel";
import LoginModal from "@/components/LoginModal";
import { Icon } from "./icons";
import SettingsView from "@/components/settings/SettingsView";
import ProfileView from "@/components/profile/ProfileView";
import LeaderboardPage from "../../app/leaderboard/page";
import "./enki-shell.css";

const PANEL_TITLES: Record<string, string> = {
  billing: "Payment", settings: "Settings", profile: "My Profile", creator: "Creator",
  leaderboard: "Hall of Fame", favorites: "Bookmarks", notifications: "Notifications", messages: "Messages",
  analytics: "Analytics",
};

const NAV: NavItem[] = [
  { id: "home", label: "Home", icon: "home" },
  // No Search entry for now (Kev, 2026-10-13): the field lives in the feed's
  // filter bar; from the editor the menu entry only closed the open panel.
  // Notifications = the activity feed (comments/ratings/generations/guardians);
  // Messages = person-to-person DMs (still a stub until that system exists).
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "messages", label: "Messages", icon: "message" },
  { id: "favorites", label: "Bookmarks", icon: "bookmark" },
  { id: "leaderboard", label: "Hall of Fame", icon: "trophy" },
  { id: "analytics", label: "Analytics", icon: "chart" },
  { id: "settings", label: "Settings", icon: "settings" },
];

// Personal areas: hidden from (and blocked for) visitors who aren't signed in.
// (Matters post-beta, when guests may browse the feed again.) History moved
// to the owner's own Profile as a tab.
const AUTHED_ONLY = new Set(["settings", "favorites", "analytics", "notifications", "messages"]);

// Same safe-wrapper pattern the old Navbar used: these wallet hooks throw if a
// provider is momentarily absent, so swallow and fall back to "not connected".
function useSafeActiveAccount() {
  try { return useActiveAccount(); } catch { return null; }
}

/* The user's own menu choice. Read during render through a store, so the
   server and the hydrating client agree (false) and the stored answer
   follows without an effect. */
const MENU_KEY = "ek-menu-collapsed";
const noSubscribe = () => () => {};
const readMenuPref = () => { try { return localStorage.getItem(MENU_KEY) === "1"; } catch { return false; } };

/** The shell. `children` take the feed's place, so a route can keep the
 *  shell (menu, login, billing panel) around its own page. */
export default function EnkiHome({ children }: { children?: React.ReactNode }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  const account = useSafeActiveAccount();
  
  const { isAuthed: emailAuthed, email, logout: emailLogout } = useEmailAuth();
  const { address: cdpAddress } = useCdpAddress();
  const { isAuthenticated: solanaAuthed, walletAddress: solanaAddress, logout: solanaLogout } = useSolanaAuth();
  const { connected: adapterConnected, disconnect: adapterDisconnect } = useWallet();
  const walletAddress = account?.address ?? cdpAddress ?? (solanaAuthed ? solanaAddress : null);
  const { payer } = useViewerWallets();
  const { balance, ready } = useHoldings(payer);
  const balanceText = balanceView({ payer, ready, balance, free: false, quote: null })?.text ?? "Add funds";

  // Access + username come from the root BetaGate (it already verified the
  // session server-side before this shell could even mount).
  const { access, role, handle: myHandle, setHandle: setMyHandle, profile: myProfile } = useBetaAccess();
  /* Team-cookie browsing is NOT authed: the cookie opens looking around,
     never the personal areas — so Bookmarks, Messages, Notifications,
     Analytics and Settings disappear from the menu entirely for it, the
     earn buttons deactivate, and the prompt creator explains itself
     (Kev, 2026-08-23). */
  const authed = access === "ok" && role !== "team";

  const emailName = emailAuthed && email ? email.split("@")[0] : null;
  const initials = myHandle
    ? myHandle.slice(0, 2).toUpperCase()
    : walletAddress
      ? (walletAddress.startsWith("0x") ? walletAddress.slice(2, 4) : walletAddress.slice(0, 2)).toUpperCase()
      : emailName ? emailName.slice(0, 2).toUpperCase() : "EA";
  const handle = myHandle ?? (walletAddress ? walletAddress.replace(/^0x/, "").slice(0, 8).toLowerCase() : emailName?.toLowerCase() ?? "guest");
  const name = myHandle ?? (walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : emailName ?? "Guest");

  /* The menu is a 72 px rail below 1200 px and the full column above, where
     the user's stored choice holds. A toggle wins until the window next
     crosses 1200. A phone shows the full menu as its drawer. */
  const narrow = useMediaQuery(RAIL);
  const phone = useMediaQuery("(max-width: 767.98px)"); // the shell's phone edge, enki-shell.css
  const storedRail = useSyncExternalStore(noSubscribe, readMenuPref, () => false);
  const [pick, setPick] = useState<{ narrow: boolean; collapsed: boolean } | null>(null);
  const collapsed = pick?.narrow === narrow ? pick.collapsed : narrow || storedRail;
  const rail = collapsed && !phone;
  const [panel, setPanel] = useState<string | null>(null); // which menu item shows in the right panel
  /* Which creator the "creator" panel shows. Opened via the cancelable
     "enki:open-creator" event: cards and artist links dispatch it, and a
     consumed event (preventDefault) tells them the shell took over — only
     surfaces OUTSIDE the shell fall back to the /creators route. */
  const [creatorHandle, setCreatorHandle] = useState<string | null>(null);
  /* The login popup, IN the shell (Kev, 2026-08-24): profile gate and
     creator notice raise enki:open-login and the LANDING'S auth modal —
     embedded, not rebuilt — opens right here. */
  const [loginOpen, setLoginOpen] = useState(false);
  useEffect(() => {
    const onOpenLogin = (e: Event) => { e.preventDefault(); setLoginOpen(true); };
    window.addEventListener("enki:open-login", onOpenLogin);
    return () => window.removeEventListener("enki:open-login", onOpenLogin);
  }, []);
  useEffect(() => {
    const onOpenCreator = (e: Event) => {
      const h = (e as CustomEvent<{ handle?: string }>).detail?.handle;
      if (!h) return;
      e.preventDefault();
      setCreatorHandle(String(h));
      setPanel("creator");
      window.dispatchEvent(new CustomEvent("enki:hide-detail"));
    };
    window.addEventListener("enki:open-creator", onOpenCreator);
    return () => window.removeEventListener("enki:open-creator", onOpenCreator);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* Deep link: /home?creator=<handle> opens the panel on arrival — the old
     /creators/[id] URLs redirect here so the shell (and its menu) is
     always around the page. */
  useEffect(() => {
    const h = new URLSearchParams(window.location.search).get("creator");
    if (h) { setCreatorHandle(h); setPanel("creator"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* "Prompt creator needs a login" notice — pops in and LEAVES with an
     animation (open -> closing -> gone), closes on ESC and free-space
     clicks. */
  const [creatorNotice, setCreatorNotice] = useState<"open" | "closing" | null>(null);
  const closeCreatorNotice = () => setCreatorNotice((s) => (s === "open" ? "closing" : s));
  useEffect(() => {
    if (creatorNotice !== "open") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closeCreatorNotice(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [creatorNotice]);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Balance chip → Payment panel, scrolled to "Add money" with a heartbeat.
  const [payFocus, setPayFocus] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const closePanel = () => {
    setPanel(null); setPayFocus(false);
    /* Whatever the panel covered comes back — a detail hidden by openPanel
       stayed invisibly mounted when the panel closed via X/scrim/ESC, and
       every card click after that opened into the hidden panel: dead feed
       (found by review, 2026-08-22). */
    window.dispatchEvent(new CustomEvent("enki:show-detail"));
  };
  // Bumped on every menu click that opens a panel: the panel content REMOUNTS,
  // so re-clicking Settings always starts back on its first page instead of
  // keeping the tab you were on.
  const [panelNonce, setPanelNonce] = useState(0);
  // settingsTab lets a caller (the recovery banner) deep-link Settings to a
  // specific tab; a plain Settings nav click clears it back to the first page.
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined);
  const openPanel = (id: string, tab?: string) => {
    setMobileDrawerOpen(false);
    /* A menu panel covering the image view HIDES it (kept mounted) — its
       scrim (z 160) sits under the detail panel (z 162), so without this the
       leaderboard opened invisibly beneath the image (Kev, 2026-08-22). */
    window.dispatchEvent(new CustomEvent("enki:hide-detail"));
    setSettingsTab(id === "settings" ? tab : undefined);
    setPanel(id);
    setPanelNonce((n) => n + 1);
  };
  // Guardians get the focus only when the recovery banner asked; the 2FA bar
  // opens the same tab, whose top section is the 2FA itself.
  const [guardianFocus, setGuardianFocus] = useState(false);
  const openRecoverySettings = () => { setGuardianFocus(true); setActiveNav("settings"); openPanel("settings", "recovery"); };

  // Unread notifications → badge on Notifications. The shared store polls +
  // refreshes on focus (near-realtime) and clears optimistically on open, so
  // the badge here just follows it — no local fetch/race to manage.
  const { unseen } = useNotifications(authed);
  const { unreadTotal: dmUnread } = useMessages(authed);

  // No recovery set up → thin red banner across the top. The X hides it on
  // this device; Settings shows its own non-dismissible copy regardless.
  const recovery = useRecoveryStatus(authed);
  const [bannerDismissed, setBannerDismissed] = useState(true);
  useEffect(() => {
    try { setBannerDismissed(localStorage.getItem("ek-recovery-banner") === "1"); } catch { /* stays hidden */ }
  }, []);
  const dismissBanner = () => {
    setBannerDismissed(true);
    try { localStorage.setItem("ek-recovery-banner", "1"); } catch { /* session-only then */ }
  };
  // One 30 px slot at the top: the permanent 2FA bar (SecondFactorBar, at the
  // root) wins; the recovery warning then shows inside Settings instead.
  const needs2fa = useNeeds2fa();
  const showRecoveryBanner = authed && recovery !== null && recovery.confirmed === 0 && !bannerDismissed && !needs2fa;
  // The shell moves its own layers under that slot (.ek-with-banner); a page
  // outside it starts below the 2FA bar instead (globals.css, html.ek-in-shell).
  // Before paint, so a move between the shell and a page never jumps.
  useLayoutEffect(() => {
    document.documentElement.classList.add("ek-in-shell");
    return () => document.documentElement.classList.remove("ek-in-shell");
  }, []);
  // Log off: confirm dialog + the actual sign-out across every auth surface.
  const [logoffOpen, setLogoffOpen] = useState(false);
  const [logoffBusy, setLogoffBusy] = useState(false);
  useEffect(() => {
    if (!logoffOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLogoffOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [logoffOpen]);
  const doLogoff = async () => {
    setLogoffBusy(true);
    try {
      await solanaLogout(); // deletes the server session, then local storage
      emailLogout();
      if (adapterConnected) await adapterDisconnect().catch(() => {});
    } finally {
      window.location.href = "/"; // hard reload → landing, all client state reset
    }
  };
  const [activeNav, setActiveNav] = useState("home");
  // The 2FA bar (SecondFactorBar) opens the 2FA settings here, in place.
  useEffect(() => {
    const onOpen2fa = (e: Event) => {
      e.preventDefault();
      setGuardianFocus(false);
      setActiveNav("settings");
      openPanel("settings", "recovery");
    };
    window.addEventListener("enki:open-2fa", onOpen2fa);
    return () => window.removeEventListener("enki:open-2fa", onOpen2fa);
  }, []);
  // "Add funds" from any surface opens Payment here. Consumed, so a page
  // outside the shell knows to open the settings page itself.
  const openBilling = useEffectEvent(() => { setPayFocus(true); openPanel("billing"); });
  useEffect(() => {
    const onOpenBilling = (e: Event) => { e.preventDefault(); openBilling(); };
    window.addEventListener("enki:open-billing", onOpenBilling);
    return () => window.removeEventListener("enki:open-billing", onOpenBilling);
  }, []);

  /* Ctrl/Cmd+K and the query itself live with the field, in SearchChip: it
     writes ?q=, EnkiFeedPage reads it and asks the server. */

  const showToast = (msg: string) => notify(msg);

  // Manual menu toggle → remember the preference.
  const toggleMenu = () => {
    setPick({ narrow, collapsed: !collapsed });
    try { localStorage.setItem(MENU_KEY, collapsed ? "0" : "1"); } catch { /* noop */ }
  };

  /* Create Prompt from anywhere: a panel open over the editor (Hall of Fame
     on /editor) closes, or the push to the same route changed nothing and the
     click looked dead (Kev, 2026-10-13). */
  const createPrompt = () => {
    if (!authed) { setCreatorNotice("open"); return; }
    setMobileDrawerOpen(false);
    setPanel(null);
    router.push("/editor");
  };

  const onNav = (id: string) => {
    setMobileDrawerOpen(false);
    // Guests can browse, but personal areas need an account.
    if (!authed && AUTHED_ONLY.has(id)) { showToast("Sign in to use this."); return; }
    if (id === "home") {
      setPanel(null); setActiveNav("home");
      /* If the image view is open, Home means "back to where I was" — close it
         and leave the feed exactly as it was, rather than routing and scrolling
         to the top of a list the reader had already worked their way down. */
      const detailEl = document.querySelector(".iv-frame");
      /* A detail HIDDEN behind a menu panel is "where I was" — Home brings it
         back instead of closing it (Kev, 2026-08-22). A VISIBLE detail keeps
         the old meaning: Home closes it, back to the feed. */
      if (detailEl?.classList.contains("is-hidden")) {
        window.dispatchEvent(new CustomEvent("enki:show-detail"));
        return;
      }
      window.dispatchEvent(new CustomEvent("enki:close-detail"));
      if (detailEl) return;
      // Nothing open: back to the whole feed (no search, All) at the top.
      router.push("/home");
      window.dispatchEvent(new CustomEvent("enki:home"));
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    // Every other menu item opens in the standalone right-side panel.
    setActiveNav(id);
    openPanel(id);
  };
  // Unified panel headline — same serif as the landing "Expert-crafted AI Art".
  const PanelHeadline = ({ title, sub }: { title: string; sub?: string }) => (
    <div className="ek-panel-hero">
      <h1><em>{title}</em></h1>
      {sub && <p>{sub}</p>}
    </div>
  );
  // Unified panel frame — same centered width as the Hall of Fame.
  const PanelFrame = ({ children }: { children: React.ReactNode }) => (
    <div style={{ maxWidth: 1080, margin: "0 auto" }}>{children}</div>
  );

  const renderPanel = (key: string) => {
    switch (key) {
      // Balance chip + billing entries render the EXACT Settings → Payment
      // view (same container, same scale), scrolled to "Add money".
      case "billing": return <SettingsView initialTab="payment" focusRamp={payFocus} />;
      {/* Analytics brings its own editorial header (design), no PanelHeadline */}
      case "analytics": return <AnalyticsPanel />;
      case "notifications": return (
        <PanelFrame>
          <PanelHeadline title="Notifications" sub="What happened around your work: comments, ratings, generations and guardian answers." />
          <NotificationsPanel onOpenRecovery={openRecoverySettings} />
        </PanelFrame>
      );
      case "messages": return <MessagesPanel toast={showToast} />;
      case "settings": return <SettingsView initialTab={settingsTab} globalBannerVisible={showRecoveryBanner} focusGuardians={settingsTab === "recovery" && guardianFocus} />;
      case "profile": return <ProfileView onBack={() => { setPanel(null); setActiveNav("home"); }} />;
      /* A CREATOR's page, in the SAME right-side panel area as everything
         else — the left menu never leaves the screen (Kev, 2026-08-24:
         "IT SHOULD BE PLACED IN THE RIGHT AREA NEXT TO THE LEFT SIDE
         MENÜ"). Same ProfileView, foreign mode. */
      case "creator": return creatorHandle
        // Keyed by handle: one creator's page never shows the last one's
        // hero, gallery or Report target while the next one loads.
        ? <ProfileView key={creatorHandle} handle={creatorHandle} isOwnProfile={false} onBack={closePanel} />
        : null;
      {/* Leaderboard brings its own editorial header (design), no PanelHeadline */}
      case "favorites": return <BookmarksPanel />;
      case "leaderboard": return <LeaderboardPage />;
      default: return (
        <PanelFrame>
          <PanelHeadline title={PANEL_TITLES[key] || key} />
          <div className="ek-panel-stub" style={{ height: "auto", padding: "80px 40px" }}>
            <Icon name="sparkles" size={26} stroke={1.6} />
            <p>This space is coming soon.</p>
          </div>
        </PanelFrame>
      );
    }
  };

  const rootClass = "ek-app" + (rail ? " ek-root--rail" : "")
    + (showRecoveryBanner || needs2fa ? " ek-with-banner" : "");

  return (
    <div className={rootClass}>
      {showRecoveryBanner && (
        <div className="ek-recovery-banner" role="alert">
          <button className="ek-recovery-banner-msg" onClick={openRecoverySettings}>
            No recovery set up. Lose this login and the account is gone — set up a guardian.
          </button>
          <button
            className="ek-recovery-banner-x"
            aria-label="Dismiss"
            onClick={dismissBanner}
          >
            <Icon name="x" size={14} stroke={2.4} />
          </button>
        </div>
      )}
      {/* Mobile Top Header (≤ 768px) */}
      <header className="ek-mobile-header">
        <div className="ek-mobile-header-left" onClick={() => onNav("home")}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="ek-mobile-header-logo" src="/enki-art-logo.png" alt="Enki Art" />
        </div>
        <div className="ek-mobile-header-right">
          {/* No balance chip for guests — the same rule the sidebar follows:
              $0 opens payment settings for someone who cannot pay yet, so
              login comes first (Kev, 2026-08-24). */}
          {authed && (
            <button
              type="button"
              className="ek-mobile-balance"
              onClick={() => { setPayFocus(true); openPanel("billing"); }}
              title="Add funds"
            >
              {balanceText}
            </button>
          )}
          <button
            type="button"
            className="ek-mobile-burger-btn kit-hit"
            onClick={() => setMobileDrawerOpen((o) => !o)}
            aria-label="Open menu"
            aria-expanded={mobileDrawerOpen}
          >
            <Icon name={mobileDrawerOpen ? "x" : "menu"} size={18} stroke={2.2} />
            {authed && (unseen + dmUnread) > 0 && !mobileDrawerOpen && (
              <span className="ek-mobile-burger-badge">{unseen + dmUnread}</span>
            )}
          </button>
        </div>
      </header>

      {/* Mobile Drawer Scrim */}
      {mobileDrawerOpen && (
        <div className="ek-mobile-drawer-scrim" onClick={() => setMobileDrawerOpen(false)} />
      )}

      <div className="ek-shell">
        <EnkiSidebar
          nav={(authed ? NAV : NAV.filter((n) => !AUTHED_ONLY.has(n.id))).map((n) =>
            n.id === "notifications" && unseen > 0 ? { ...n, badge: unseen }
              : n.id === "messages" && dmUnread > 0 ? { ...n, badge: dmUnread }
              : n
          )}
          active={activeNav}
          onNav={onNav}
          rail={rail}
          onCreate={createPrompt}
          guest={!authed}
          onFeedback={() => setFeedbackOpen(true)}
          account={{ name, handle, initials, avatarUrl: myProfile?.avatarUrl ?? null }}
          collapsed={rail}
          onToggleCollapse={toggleMenu}
          balance={balanceText}
          onProfile={() => { setActiveNav(""); openPanel("profile"); }}
          onTopUp={() => { setPayFocus(true); openPanel("billing"); }}
          onLogoff={authed ? () => setLogoffOpen(true) : undefined}
          theme={theme}
          setTheme={setTheme}
          mobileOpen={mobileDrawerOpen}
          onCloseMobile={() => setMobileDrawerOpen(false)}
        />

        <main className="ek-main">
          {/* No top bar. It held only the search input, which is now a glyph
              in the category bar, and an empty 56px strip with a border and a
              background is not "nothing" — it is a band of unused screen above
              the first thing the reader wants (Kev, 2026-08-13). */}
          {children ?? <EnkiFeedPage />}
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar (≤ 768px) */}
      <nav className="ek-mobile-bottom-nav" aria-label="Mobile navigation">
        <button
          type="button"
          className={"ek-mobile-nav-btn" + (activeNav === "home" && !panel ? " active" : "")}
          onClick={() => onNav("home")}
          aria-label="Home"
        >
          <Icon name="home" size={20} stroke={activeNav === "home" && !panel ? 2.4 : 1.9} />
          <span>Home</span>
        </button>
        <button
          type="button"
          className="ek-mobile-nav-btn ek-mobile-nav-btn--create"
          onClick={createPrompt}
          aria-label="Create Prompt"
        >
          <span className="ek-mobile-nav-create-pill">
            <Icon name="pen" size={18} stroke={2.4} />
          </span>
        </button>
        {/* Bookmarks are AUTHED_ONLY: the desktop nav filters them out for
            guests, so the bar must not offer them either (guest honesty). */}
        {authed && (
          <button
            type="button"
            className={"ek-mobile-nav-btn" + (panel === "favorites" ? " active" : "")}
            onClick={() => onNav("favorites")}
            aria-label="Bookmarks"
          >
            <Icon name="bookmark" size={20} stroke={panel === "favorites" ? 2.4 : 1.9} />
            <span>Bookmarks</span>
          </button>
        )}
        <button
          type="button"
          className={"ek-mobile-nav-btn" + (panel === "profile" ? " active" : "")}
          onClick={() => {
            if (!authed) { openLogin(); return; }
            setActiveNav(""); openPanel("profile");
          }}
          aria-label={authed ? "Profile" : "Log in"}
        >
          <span className="ek-avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
            {authed && myProfile?.avatarUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={myProfile.avatarUrl} alt="" />
            ) : authed ? initials : <Icon name="user" size={13} stroke={2} />}
          </span>
          <span>{authed ? "Profile" : "Log in"}</span>
        </button>
      </nav>

      {panel && (
        <EnkiPanel title={PANEL_TITLES[panel] || panel} onClose={closePanel} full
          hideClose={panel === "leaderboard" && !phone}>
          {/* The key remounts only the CONTENT (fresh state per menu click);
              the panel shell stays mounted, so its fade-in doesn't replay and
              the home feed never flashes through between panels. */}
          <div key={`${panel}:${panelNonce}`} style={{ display: "contents" }}>
            {renderPanel(panel)}
          </div>
        </EnkiPanel>
      )}

      {creatorNotice && (
        <div
          className={"ek-modal-scrim ek-notice-scrim" + (creatorNotice === "closing" ? " leaving" : "")}
          style={{ zIndex: 1450 }}
          onClick={closeCreatorNotice}
          onAnimationEnd={() => { if (creatorNotice === "closing") setCreatorNotice(null); }}
        >
          <div className="ek-modal ek-notice" style={{ maxWidth: 330 }} onClick={(e) => e.stopPropagation()}>
            <p className="ek-notice-text">The prompt creator is for logged in users. Sign in and it opens right up.</p>
            <button type="button" className="ek-btn" style={{ minHeight: 36, width: "100%" }} onClick={() => { setCreatorNotice(null); openLogin(); }}>
              Sign in
            </button>
          </div>
        </div>
      )}
      <LoginModal open={loginOpen} prewarm={!authed} onClose={() => setLoginOpen(false)} />
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} onToast={showToast} guest={!authed} />}

      {logoffOpen && (
        <div className="ek-modal-scrim" onClick={() => !logoffBusy && setLogoffOpen(false)}>
          <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="ek-modal-head">
              <span className="ek-sheet-bolt"><Icon name="logout" size={16} stroke={2} /></span>
              <span className="ek-modal-title">Log off?</span>
              <button className="ek-modal-x" onClick={() => setLogoffOpen(false)} disabled={logoffBusy}>
                <Icon name="x" size={17} stroke={2} />
              </button>
            </div>
            <div className="ek-modal-body">
              <p style={{ fontSize: 13.5, color: "var(--enki-ink-3)", lineHeight: 1.55, marginBottom: 18 }}>
                You&apos;ll be signed out on this device and land back on the front page.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button className="ek-btn" style={{ minHeight: 44 }} onClick={doLogoff} disabled={logoffBusy}>
                  <Icon name="logout" size={15} stroke={2} /> {logoffBusy ? "Logging off…" : "Yes, log me off"}
                </button>
                <button
                  onClick={() => setLogoffOpen(false)}
                  disabled={logoffBusy}
                  style={{ minHeight: 36, border: "none", background: "transparent", color: "var(--enki-ink-3)", fontSize: 12.5, cursor: "pointer" }}
                >
                  Stay signed in
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* First login with no username yet → the big name picker (no skip —
          a free adjective_artist default is prefilled). */}
      {myHandle === null && (
        <UsernameOnboard email={email} wallet={walletAddress} onDone={(h) => setMyHandle(h)} />
      )}
    </div>
  );
}
