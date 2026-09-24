"use client";

/**
 * /auth/complete#next=/path  or  #error=code
 *
 * The OAuth callback lands here with the session in a short lived httpOnly
 * cookie, never in the URL. The page collects it with one POST to
 * /api/auth/oauth/complete (which clears the cookie), stores it exactly like
 * a password login, wipes the fragment from history and moves on to `next`,
 * or to /banned for a banned account. Without the cookie, which only the
 * browser that finished the provider round trip holds, the POST answers 401
 * and nothing is stored: a link somebody else crafted cannot sign anyone in.
 */
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { storeSession } from "@/hooks/useEmailAuth";
import { ERROR_SENTENCES, sanitizeNext } from "@/lib/auth/oauth-shared";

// The fragment is browser only state: read it as an external store so the
// server snapshot (empty) hydrates cleanly and the client re-renders with it.
const never = () => () => {};
const useHash = () => useSyncExternalStore(never, () => window.location.hash, () => "");
const sentence = (code: string | null) =>
  code ? ERROR_SENTENCES[code as keyof typeof ERROR_SENTENCES] ?? ERROR_SENTENCES.provider_error : null;

export default function AuthCompletePage() {
  const fragmentError = sentence(new URLSearchParams(useHash().replace(/^#/, "")).get("error"));
  const [collectError, setCollectError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // The live fragment, not the render snapshot: the hydration pass renders with an empty one.
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (params.get("error") || started.current) return;
    started.current = true; // the cookie is single use: one POST, even under strict mode
    const next = sanitizeNext(params.get("next"));
    window.history.replaceState(null, "", window.location.pathname);
    fetch("/api/auth/oauth/complete", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) {
          setCollectError(ERROR_SENTENCES.state_mismatch);
          return;
        }
        const data = (await res.json()) as { token: string; email: string | null; banned: boolean };
        storeSession({ token: data.token, email: data.email ?? undefined });
        window.location.replace(data.banned ? "/banned" : next);
      })
      .catch(() => setCollectError(ERROR_SENTENCES.provider_error));
  }, []);

  const error = fragmentError ?? collectError;
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
