"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { passkeyStepUpToken } from "@/hooks/usePasskey";

/**
 * The step-up dialog, mounted once (providers/index.tsx). When the server
 * answers 401 { stepUp, factors }, `guarded` asks the user to confirm with
 * one of their factors (passkey, authenticator app, email code) and runs the
 * request again with the token. Cancelling resolves to the first answer.
 */

export type Factor = "passkey" | "totp" | "email";
type Ask = (scope: string, factors: Factor[]) => Promise<string | null>;
type Pending = { scope: string; factors: Factor[]; resolve: (token: string | null) => void };

const Ctx = createContext<Ask>(async () => null);

async function postJson(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...sessionAuthHeaders() },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as { token?: string; error?: string } };
}

async function codeToken(scope: string, factor: "totp" | "email", code: string): Promise<string> {
  const { ok, data } = await postJson("/api/auth/stepup", { scope, factor, code });
  if (!ok || !data.token) throw new Error(data.error || "That did not work");
  return data.token;
}

export function StepUpProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [mode, setMode] = useState<"totp" | "email" | null>(null);
  const [code, setCode] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback<Ask>(
    (scope, factors) =>
      new Promise((resolve) => {
        setCode("");
        setError(null);
        setEmailSent(false);
        setMode(factors.includes("passkey") ? null : factors.includes("totp") ? "totp" : factors.includes("email") ? "email" : null);
        // A second ask while one is open cancels the first, so no caller waits forever.
        setPending((prev) => {
          prev?.resolve(null);
          return { scope, factors, resolve };
        });
      }),
    [],
  );

  const finish = (token: string | null) => {
    pending?.resolve(token);
    setPending(null);
  };
  const attempt = async (get: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      finish(await get());
    } catch (e) {
      const msg = e instanceof Error ? e.message : "That did not work";
      if (!/cancel|abort|NotAllowed/i.test(msg)) setError(msg);
    } finally {
      setBusy(false);
    }
  };
  const sendEmail = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await postJson("/api/auth/stepup/email", {});
      if (ok) setEmailSent(true);
      else setError(data.error || "The code could not be sent");
    } catch {
      setError("The code could not be sent");
    } finally {
      setBusy(false);
    }
  };

  const has = (f: Factor) => pending?.factors.includes(f) ?? false;
  const btn = "w-full rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50";

  return (
    <Ctx.Provider value={ask}>
      {children}
      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open && !busy) finish(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm it&apos;s you</DialogTitle>
            <DialogDescription>This needs your second factor. Nothing happens until you confirm.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {has("passkey") && (
              <button className={btn} disabled={busy} onClick={() => pending && attempt(() => passkeyStepUpToken(pending.scope))}>
                Use your passkey
              </button>
            )}
            {has("totp") && mode !== "totp" && (
              <button className={btn} disabled={busy} onClick={() => { setMode("totp"); setCode(""); setError(null); }}>
                Use your authenticator app
              </button>
            )}
            {has("email") && mode !== "email" && (
              <button className={btn} disabled={busy} onClick={() => { setMode("email"); setCode(""); setError(null); }}>
                Get a code by email
              </button>
            )}
            {mode === "email" && !emailSent && (
              <button className={btn} disabled={busy} onClick={sendEmail}>Email me a code</button>
            )}
            {(mode === "totp" || (mode === "email" && emailSent)) && (
              <form
                className="grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (pending && mode) attempt(() => codeToken(pending.scope, mode, code));
                }}
              >
                <input
                  className="rounded-md border px-3 py-2 text-center text-lg tracking-[0.3em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  autoFocus
                />
                <button className={btn} type="submit" disabled={busy || code.length !== 6}>
                  {mode === "totp" ? "Confirm with the app's code" : "Confirm with the emailed code"}
                </button>
                {mode === "email" && (
                  <button type="button" className="text-xs underline disabled:opacity-50" disabled={busy} onClick={sendEmail}>
                    Send a new code
                  </button>
                )}
              </form>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}

/**
 * Whether an action the server cannot see (a key export through CDP) may go
 * ahead: once the user confirmed it with a factor, or at once when they have
 * none, since 2FA is optional (Kev, 2026-10-07). False when they cancelled;
 * throws when the factors cannot be read, which must never read as "none".
 */
export async function confirmAction(scope: string, ask: Ask): Promise<boolean> {
  const res = await fetch("/api/auth/stepup", { headers: sessionAuthHeaders() });
  if (!res.ok) throw new Error("Could not check your security settings. Try again.");
  const factors = ((await res.json()) as { factors?: Factor[] }).factors ?? [];
  return factors.length === 0 || Boolean(await ask(scope, factors));
}

/** Runs a request; when the server asks for a step-up, asks the user and runs it again with the token. */
export async function withStepUp(
  scope: string,
  run: (headers: Record<string, string>) => Promise<Response>,
  ask: Ask,
): Promise<Response> {
  const first = await run({});
  if (first.status !== 401) return first;
  const body = (await first.clone().json().catch(() => null)) as { stepUp?: boolean; factors?: Factor[] } | null;
  if (!body?.stepUp) return first;
  const token = await ask(scope, body.factors ?? []);
  return token ? run({ "X-StepUp-Token": token }) : first;
}

export function useStepUp() {
  const ask = useContext(Ctx);

  const guarded = useCallback(
    (scope: string, run: (headers: Record<string, string>) => Promise<Response>) => withStepUp(scope, run, ask),
    [ask],
  );

  /** A token for this scope, asking with whatever factors the user has; null without one. */
  const tokenFor = useCallback(
    async (scope: string): Promise<string | null> => {
      const res = await fetch("/api/auth/stepup", { headers: sessionAuthHeaders() });
      const factors = res.ok ? (((await res.json()) as { factors?: Factor[] }).factors ?? []) : [];
      return factors.length ? ask(scope, factors) : null;
    },
    [ask],
  );

  const confirm = useCallback((scope: string) => confirmAction(scope, ask), [ask]);

  return { guarded, tokenFor, confirm };
}
