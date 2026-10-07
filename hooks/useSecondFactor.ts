"use client";

import { useQuery } from "@tanstack/react-query";
import { useBetaAccess } from "@/components/BetaGate";
import { sessionAuthHeaders } from "@/lib/session-headers";
import type { Factor } from "@/components/StepUpProvider";

export const STEPUP_FACTORS_KEY = ["stepup-factors"] as const;

/** The signed-in account's second factors (GET /api/auth/stepup), shared by
    the red bar, the shell and Settings. A failed read throws, so an outage
    never reads as "no 2FA". emailCodes: whether an email code can be a
    factor here (never for an email account: its inbox resets the password). */
export function useStepUpFactors(enabled = true) {
  return useQuery({ queryKey: STEPUP_FACTORS_KEY, enabled, retry: 2, queryFn: fetchStepUpFactors });
}

export async function fetchStepUpFactors(): Promise<{ factors: Factor[]; emailCodes: boolean }> {
  const res = await fetch("/api/auth/stepup", { headers: sessionAuthHeaders() });
  if (!res.ok) throw new Error(`Could not read your security settings (${res.status})`);
  return res.json();
}

/** Signed in (not team-code browsing) and no second factor yet: 2FA is
    optional, and the red bar asks for it (Kev, 2026-10-07). Unknown is not
    missing: the bar waits for an answer. */
export function missingSecondFactor(authed: boolean, data: { factors: Factor[] } | undefined): boolean {
  return authed && data !== undefined && data.factors.length === 0;
}

export function useNeeds2fa(): boolean {
  const { access, role } = useBetaAccess();
  const authed = access === "ok" && role !== "team";
  const { data } = useStepUpFactors(authed);
  return missingSecondFactor(authed, data);
}
