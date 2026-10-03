/**
 * Client-side auth header for session-protected API routes.
 *
 * Both wallet session types (Turnkey email + Solana sign-in) store a token
 * that lives in auth_sessions and is accepted by requireAuth via
 * X-Session-Token. This reads whichever session the browser holds so callers
 * (gallery delete, generation status PATCH, …) can prove ownership without
 * each component wiring up every auth hook.
 */
export function sessionAuthHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const email = localStorage.getItem("enki_session_token");
  if (email) return { "X-Session-Token": email };
  const turnkey = localStorage.getItem("turnkey_session_token");
  if (turnkey) return { "X-Session-Token": turnkey };
  try {
    const raw = localStorage.getItem("solana-auth-session");
    if (raw) {
      const token = (JSON.parse(raw) as { sessionToken?: string }).sessionToken;
      if (token) return { "X-Session-Token": token };
    }
  } catch {
    /* ignore malformed session */
  }
  return {};
}

/** Where the feed's 18+ pill is kept: the id of the account that turned it on (BetaGate). */
export const SHOW_ADULT_KEY = "enki:show-adult";

/** Whether a stored pill survives the sign-in check: only for the confirmed account that turned it on. */
export function pillSurvives(stored: string | null, account: { id?: string; adultConfirmed?: boolean }): boolean {
  return Boolean(stored) && account.adultConfirmed === true && stored === account.id;
}

/** The session, plus the 18+ pill when it is on. The server still checks the age confirmation behind it. */
export function sessionHeadersWith(showAdult: boolean): Record<string, string> {
  return showAdult ? { ...sessionAuthHeaders(), "X-Show-Adult": "1" } : sessionAuthHeaders();
}

/** For reads that show other people's work: the session plus the stored pill. */
export function viewerHeaders(): Record<string, string> {
  let on = false;
  try {
    on = Boolean(localStorage.getItem(SHOW_ADULT_KEY));
  } catch {
    /* no storage: the safe view */
  }
  return sessionHeadersWith(on);
}
