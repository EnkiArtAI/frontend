"use client";

/**
 * /auth/complete#token=…&next=/path[&email=…][&banned=1]  or  #error=code
 *
 * The OAuth callback lands here with the session in the URL fragment (never a
 * query string, so it reaches no log or referrer). The token is stored exactly
 * like a password login, the fragment is wiped from history, and the browser
 * moves on to `next`, or to /banned for a banned account.
 */
import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import { storeSession } from "@/hooks/useEmailAuth";
import { ERROR_SENTENCES, sanitizeNext } from "@/lib/auth/oauth-shared";

// The fragment is browser only state: read it as an external store so the
// server snapshot (empty) hydrates cleanly and the client re-renders with it.
const never = () => () => {};
const useHash = () => useSyncExternalStore(never, () => window.location.hash, () => "");

export default function AuthCompletePage() {
  const hash = useHash();
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token");
  const email = params.get("email");
  const next = params.get("banned") === "1" ? "/banned" : sanitizeNext(params.get("next"));
  const error = hash && !token
    ? ERROR_SENTENCES[params.get("error") as keyof typeof ERROR_SENTENCES] ?? ERROR_SENTENCES.provider_error
    : null;

  useEffect(() => {
    if (!token) return;
    window.history.replaceState(null, "", window.location.pathname);
    storeSession({ token, email: email ?? undefined });
    window.location.replace(next);
  }, [token, email, next]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
      {error ? (
        <div style={{ maxWidth: 420 }}>
          <p style={{ marginBottom: 16 }}>{error}</p>
          <Link href="/" style={{ textDecoration: "underline" }}>Back to the start</Link>
        </div>
      ) : (
        <p>Signing you in…</p>
      )}
    </main>
  );
}
