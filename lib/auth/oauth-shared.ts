/** The pieces of the OAuth flow both the server and /auth/complete need. No node imports here. */
export type OAuthErrorCode = "not_whitelisted" | "provider_error" | "state_mismatch" | "already_linked" | "not_configured" | "network_blocked";

/** What /auth/complete shows for each refusal. */
export const ERROR_SENTENCES: Record<OAuthErrorCode, string> = {
  not_whitelisted: "This account is not on the access list yet. Request access to join.",
  provider_error: "The sign in with the provider did not complete. Please try again.",
  state_mismatch: "This sign in link is no longer valid. Please start again.",
  already_linked: "That account is already connected to another user.",
  not_configured: "This sign in method is not configured on this server yet.",
  network_blocked: "Access from this network is blocked.",
};

/**
 * The only shape a return path may take: one leading slash, then anything but
 * a second slash or backslash (a scheme relative //evil.example is a redirect
 * off site) and no whitespace. Everything else goes to /home.
 */
export const DEFAULT_NEXT = "/home";
export function sanitizeNext(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 512) return DEFAULT_NEXT;
  return /^\/(?![/\\])\S*$/.test(raw) ? raw : DEFAULT_NEXT;
}
