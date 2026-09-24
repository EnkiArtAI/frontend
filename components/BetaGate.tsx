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
import { sessionAuthHeaders } from "@/lib/session-headers";
import AccessGate from "@/components/enki-shell/AccessGate";

const PUBLIC_PATHS = new Set(["/", "/landing", "/gate", "/guardian", "/reset-password", "/auth/complete"]);
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
}

const Ctx = createContext<BetaAccess>({
  access: "checking", role: null, handle: undefined, setHandle: () => {},
  profile: null, setProfile: () => {},
});
export const useBetaAccess = () => useContext(Ctx);

export default function BetaGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [access, setAccess] = useState<"checking" | "ok" | "denied">("checking");
  const [role, setRole] = useState<string | null>(null);
  const [handle, setHandleState] = useState<string | null | undefined>(undefined);
  const [profile, setProfile] = useState<GateProfile | null>(null);
  const setHandle = (h: string | null) => {
    setHandleState(h);
    setProfile((p) => (p ? { ...p, handle: h } : p));
  };
  const [tick, setTick] = useState(0);

  // Re-verify when a login/logout happens in this or another tab.
  useEffect(() => {
    const rerun = () => { setAccess("checking"); setTick((t) => t + 1); };
    window.addEventListener("enki-email-auth-changed", rerun);
    window.addEventListener(CDP_ADDRESS_EVENT, rerun);
    window.addEventListener("storage", rerun);
    return () => {
      window.removeEventListener("enki-email-auth-changed", rerun);
      window.removeEventListener(CDP_ADDRESS_EVENT, rerun);
      window.removeEventListener("storage", rerun);
    };
  }, []);

  useEffect(() => {
    let dead = false;
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
    if (Object.keys(headers).length === 0) { void teamFallback(); return () => { dead = true; }; }
    (async () => {
      try {
        const res = await fetch("/api/users/handle", { headers });
        if (dead) return;
        if (!res.ok) { void teamFallback(); return; }
        const data = (await res.json()) as {
          handle: string | null; role?: string;
          bio?: string | null; avatarUrl?: string | null; coverUrl?: string | null;
        };
        setHandleState(data.handle ?? null);
        setProfile({
          handle: data.handle ?? null,
          bio: data.bio ?? null,
          avatarUrl: data.avatarUrl ?? null,
          coverUrl: data.coverUrl ?? null,
        });
        setRole(data.role ?? "user");
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
    <Ctx.Provider value={{ access, role, handle, setHandle, profile, setProfile }}>
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
