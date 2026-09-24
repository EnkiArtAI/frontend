"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Email + password auth (register / login / forgot / reset).
 *
 * Stores the session token in localStorage; every session-protected fetch
 * picks it up via lib/session-headers. The wallet is provisioned separately by
 * Dynamic from this session — this hook only owns login state.
 */
const TOKEN_KEY = "enki_session_token";
const EMAIL_KEY = "enki_session_email";
const EVENT = "enki-email-auth-changed";

async function post(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "Something went wrong");
  return data as { token?: string; expiresAt?: string; email?: string; banned?: boolean };
}

/** Persist a fresh session the way every login path does (password, provider). */
export function storeSession(data: { token?: string; email?: string }) {
  if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
  if (data.email) localStorage.setItem(EMAIL_KEY, data.email);
  window.dispatchEvent(new Event(EVENT));
}
const store = storeSession;

export function useEmailAuth() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setEmail(localStorage.getItem(EMAIL_KEY));
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const register = useCallback(async (e: string, password: string) => {
    store(await post("/api/auth/password/register", { email: e, password }));
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const data = await post("/api/auth/password/login", { identifier, password });
    store(data);
    // banned accounts keep exactly one door: status, appeal, funds
    if (data.banned) window.location.href = "/banned";
  }, []);

  const forgot = useCallback(async (e: string) => {
    await post("/api/auth/password/forgot", { email: e });
  }, []);

  const reset = useCallback(async (token: string, password: string) => {
    store(await post("/api/auth/password/reset", { token, password }));
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
    // Kill the Dynamic SDK session too: its runtime unmounts on logout (lazy
    // mount, see providers), so it can't log itself out — clearing its storage
    // keeps wallet sessions from leaking into the next account's login.
    Object.keys(localStorage)
      .filter((k) => k.startsWith("dynamic_"))
      .forEach((k) => localStorage.removeItem(k));
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return { email, isAuthed: !!email, register, login, forgot, reset, logout };
}
