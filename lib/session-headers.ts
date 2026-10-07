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

/** The localStorage keys sessionAuthHeaders reads a session from. */
const SESSION_KEYS = new Set(["enki_session_token", "turnkey_session_token", "solana-auth-session"]);

/**
 * Whether a storage change from another tab can have changed who is signed
 * in: a session key, or the whole store cleared (key null). The editors
 * autosave their drafts every 400 ms, and those writes say nothing about the
 * session (Kev, 2026-10-06).
 */
export function isSessionStorageKey(key: string | null): boolean {
  return key === null || SESSION_KEYS.has(key);
}

/** Where the feed's 18+ pill is kept: the id of the account that turned it on (BetaGate). */
export const SHOW_ADULT_KEY = "enki:show-adult";

/**
 * Whether the pill is on for the account signed in right now. Set only by
 * BetaGate, once the sign-in check has confirmed the stored pill belongs to
 * this confirmed account; storage is where it is kept, not what is sent.
 */
let pillActive = false;
export function setPillActive(on: boolean): void {
  pillActive = on;
}

/** Whether a stored pill survives the sign-in check: only for the confirmed account that turned it on. */
export function pillSurvives(stored: string | null, account: { id?: string; adultConfirmed?: boolean }): boolean {
  return Boolean(stored) && account.adultConfirmed === true && stored === account.id;
}

/** The session, plus the 18+ pill when it is on. The server still checks the age confirmation behind it. */
export function sessionHeadersWith(showAdult: boolean): Record<string, string> {
  return showAdult ? { ...sessionAuthHeaders(), "X-Show-Adult": "1" } : sessionAuthHeaders();
}

/** For reads that show other people's work: the session plus the pill, if BetaGate confirmed it. */
export function viewerHeaders(): Record<string, string> {
  return sessionHeadersWith(pillActive);
}
