"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { PUBLIC_PATHS } from "@/components/BetaGate";
import { useNeeds2fa } from "@/hooks/useSecondFactor";

/**
 * The permanent red bar (Kev, 2026-10-07): every signed-in account without a
 * second factor sees it at the top, on every page, with no way to close it.
 * 2FA stays optional; the bar is the reminder that the account is at risk.
 * It opens the 2FA settings in the shell, or the Settings page elsewhere.
 * It displaces the page, never covers it: fixed layers read --ek-banner-h,
 * and a page outside the shell starts below it (html.ek-2fa-bar, globals.css).
 */
export default function SecondFactorBar() {
  const pathname = usePathname() ?? "/";
  const needs2fa = useNeeds2fa();
  const show = needs2fa && !PUBLIC_PATHS.has(pathname) && !pathname.startsWith("/banned")
    && typeof window !== "undefined" && window.top === window.self;

  useEffect(() => {
    if (!show) return;
    const root = document.documentElement;
    root.style.setProperty("--ek-banner-h", "30px");
    root.classList.add("ek-2fa-bar");
    return () => {
      root.style.removeProperty("--ek-banner-h");
      root.classList.remove("ek-2fa-bar");
    };
  }, [show]);

  if (!show) return null;
  const open = () => {
    const notConsumed = window.dispatchEvent(new CustomEvent("enki:open-2fa", { cancelable: true }));
    if (notConsumed) window.location.assign("/settings?tab=recovery");
  };
  return (
    <button
      type="button"
      onClick={open}
      style={{
        position: "fixed", top: 0, left: 0, right: 0, height: 30, zIndex: 300,
        background: "#b3271e", color: "#fff", border: "none", padding: "0 14px",
        fontFamily: "inherit", fontWeight: 600, fontSize: 12.5, lineHeight: "30px", textAlign: "center", cursor: "pointer",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}
    >
      No 2FA yet: your account is at risk. Set it up
    </button>
  );
}
