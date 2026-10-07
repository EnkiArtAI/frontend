"use client";

/**
 * Root-level closed-beta wall. Mounted once in providers around ALL pages, so
 * every route — current and future — is restricted by default; only the few
 * PUBLIC_PATHS render for visitors. Access requires a server-verified session
 * whose role is beta/mod/admin (fails closed on any error).
 *
 * The session lives in localStorage (not cookies), so server middleware can't
 * see it on page loads — this client wall plus per-request auth on the APIs is
 * the enforcement pair.
 */
import { CDP_ADDRESS_EVENT } from "@/lib/cdp-bridge";
import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { SHOW_ADULT_KEY, isSessionStorageKey, pillSurvives, sessionAuthHeaders, setPillActive } from "@/lib/session-headers";
import { useQueryClient } from "@tanstack/react-query";
import AccessGate from "@/components/enki-shell/AccessGate";

const PUBLIC_PATHS = new Set(["/", "/landing", "/gate", "/guardian", "/reset-password"]);
const BETA_ROLES = new Set(["beta", "mod", "admin"]);

/** Profile bits the gate check already fetches — pages (profile) reuse them
    for an instant first paint instead of waiting on their own fetch. */
export type GateProfile = {
  handle: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
};

interface BetaAccess {
  access: "checking" | "ok" | "denied";
  role: string | null;
  /** users.handle — undefined while loading, null = signed in but not picked yet. */
  handle: string | null | undefined;
  setHandle: (h: string | null) => void;
  profile: GateProfile | null;
  setProfile: (p: GateProfile) => void;
  /** Confirmed 18 or older in Settings: the feed may offer its 18+ pill. */
  adultConfirmed: boolean;
  setAdultConfirmed: (v: boolean) => void;
  /** The feed's 18+ pill, this account's own. */
  adultPill: boolean;
  setAdultPill: (on: boolean) => void;
}

const Ctx = createContext<BetaAccess>({
  access: "checking", role: null, handle: undefined, setHandle: () => {},
  profile: null, setProfile: () => {},
  adultConfirmed: false, setAdultConfirmed: () => {},
  adultPill: false, setAdultPill: () => {},
});
export const useBetaAccess = () => useContext(Ctx);

export default function BetaGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [access, setAccess] = useState<"checking" | "ok" | "denied">("checking");
  const [role, setRole] = useState<string | null>(null);
  const [handle, setHandleState] = useState<string | null | undefined>(undefined);
  const [profile, setProfile] = useState<GateProfile | null>(null);
  const [adultConfirmed, setAdultConfirmedState] = useState(false);
  const [adultPill, setAdultPillState] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  // Every cached read was made with the old pill; a change refetches them all.
  const queryClient = useQueryClient();
  /* The 18+ pill belongs to the account that turned it on: the stored value
     is that account's id, so another account in this browser starts with it
     off, and logging out forgets it. viewerHeaders reads the same key. */
  const setAdultPill = (on: boolean) => {
    try {
      if (on && meId) localStorage.setItem(SHOW_ADULT_KEY, meId);
      else localStorage.removeItem(SHOW_ADULT_KEY);
    } catch { /* not kept */ }
    setAdultPillState(on && Boolean(meId));
    // Set before anything renders again, so every read after the flip carries it.
    setPillActive(on && Boolean(meId) && adultConfirmed);
    void queryClient.invalidateQueries();
  };
  /** A change in Settings: the pill starts off after it, either way. */
  const setAdultConfirmed = (v: boolean) => { setAdultConfirmedState(v); setAdultPill(false); };
  const setHandle = (h: string | null) => {
    setHandleState(h);
    setProfile((p) => (p ? { ...p, handle: h } : p));
  };
  const [tick, setTick] = useState(0);

  /* Re-verify when a login/logout happens in this or another tab. Only a
     session key counts as one: every editor autosave used to re-run this in
     all other tabs. And the page stays mounted while it re-checks: blanking
     it to "checking" unmounted whatever was open, an unsaved Editor 2 graph
     included (Kev, 2026-10-06). */
  useEffect(() => {
    const rerun = () => setTick((t) => t + 1);
    const onStorage = (e: StorageEvent) => { if (isSessionStorageKey(e.key)) rerun(); };
    window.addEventListener("enki-email-auth-changed", rerun);
    window.addEventListener(CDP_ADDRESS_EVENT, rerun);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("enki-email-auth-changed", rerun);
      window.removeEventListener(CDP_ADDRESS_EVENT, rerun);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    let dead = false;
    // A new check is a possibly new account: nothing 18+ until it answers.
    const forgetPill = () => { try { localStorage.removeItem(SHOW_ADULT_KEY); } catch { /* none */ } };
    setAdultConfirmedState(false);
    setAdultPillState(false);
    setPillActive(false);
    /* No session (or a denied one): a valid TEAM-CODE cookie still opens the
       UI for browsing — team members enter with the code alone (Kev,
       2026-08-23). Server APIs keep requiring a real session for anything
       user-bound; this wall is only the client half of the pair. */
    const teamFallback = async () => {
      try {
        const r = await fetch("/api/gate");
        const d = await r.json().catch(() => ({}));
        if (dead) return;
        if (d?.team === true) { setRole("team"); setAccess("ok"); return; }
      } catch { /* fall through to denied */ }
      if (!dead) setAccess("denied");
    };
    const headers = sessionAuthHeaders();
    // Signed out: the pill goes with the session.
    if (Object.keys(headers).length === 0) { forgetPill(); void teamFallback(); return () => { dead = true; }; }
    (async () => {
      try {
        const res = await fetch("/api/users/handle", { headers });
        if (dead) return;
        // A dead session forgets the pill; a passing error keeps it for later.
        if (!res.ok) { if (res.status === 401) forgetPill(); void teamFallback(); return; }
        const data = (await res.json()) as {
          id?: string; handle: string | null; role?: string;
          bio?: string | null; avatarUrl?: string | null; coverUrl?: string | null;
          adultConfirmed?: boolean;
        };
        // A logout or switch during the read superseded this check: its answer
        // must not set anything, the pill flag least of all.
        if (dead) return;
        setHandleState(data.handle ?? null);
        setProfile({
          handle: data.handle ?? null,
          bio: data.bio ?? null,
          avatarUrl: data.avatarUrl ?? null,
          coverUrl: data.coverUrl ?? null,
        });
        setRole(data.role ?? "user");
        const confirmed = data.adultConfirmed === true;
        let stored: string | null = null;
        try { stored = localStorage.getItem(SHOW_ADULT_KEY); } catch { /* none */ }
        // Another account's pill, or one without a confirmation, is switched off.
        if (stored && !pillSurvives(stored, data)) { forgetPill(); stored = null; }
        setMeId(data.id ?? null);
        // Set here, before the page below mounts in the same render: its first
        // reads go out before any effect of this gate would run.
        setPillActive(confirmed && Boolean(stored));
        setAdultConfirmedState(confirmed);
        setAdultPillState(Boolean(stored));
        if (BETA_ROLES.has(data.role ?? "user")) setAccess("ok");
        else void teamFallback();
      } catch {
        if (!dead) void teamFallback();
      }
    })();
    return () => { dead = true; };
  }, [tick]);

  const isPublic = PUBLIC_PATHS.has(pathname ?? "/");

  return (
    <Ctx.Provider value={{ access, role, handle, setHandle, profile, setProfile, adultConfirmed, setAdultConfirmed, adultPill, setAdultPill }}>
      {isPublic || access === "ok" ? (
        children
      ) : access === "denied" ? (
        <AccessGate />
      ) : (
        <div style={{ minHeight: "100vh" }} />
      )}
    </Ctx.Provider>
  );
}
