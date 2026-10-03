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

/** Where the feed's 18+ pill is kept. */
export const SHOW_ADULT_KEY = "enki:show-adult";

/**
 * For reads that show other people's work: the session plus the 18+ pill.
 * The server still checks the age confirmation behind the pill.
 */
export function viewerHeaders(): Record<string, string> {
  const headers = sessionAuthHeaders();
  try {
    if (localStorage.getItem(SHOW_ADULT_KEY) === "1") headers["X-Show-Adult"] = "1";
  } catch {
    /* no storage: the safe view */
  }
  return headers;
}
