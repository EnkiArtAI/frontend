"use client";

import { useCallback, useState } from "react";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { sessionAuthHeaders } from "@/lib/session-headers";

/**
 * App-side passkeys. enroll() registers one for the signed-in user (a
 * further factor needs a step-up token, which the caller passes);
 * passkeyStepUpToken(scope) runs a passkey challenge and returns the token
 * for X-StepUp-Token. The dialog that picks a factor lives in
 * components/StepUpProvider.tsx.
 */
async function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...sessionAuthHeaders(), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** A step-up token from a passkey tap, for this scope. */
export async function passkeyStepUpToken(scope: string): Promise<string> {
  const opts = await post("/api/auth/passkey/stepup/options");
  if (!opts.ok) throw new Error(opts.data?.error || "Could not start verification");
  const asseResp = await startAuthentication({ optionsJSON: opts.data });
  const verify = await post("/api/auth/passkey/stepup/verify", { response: asseResp, scope });
  if (!verify.ok || !verify.data?.token) throw new Error(verify.data?.error || "Passkey verification failed");
  return verify.data.token as string;
}

/** The server wants a step-up (or, for a first factor, a fresh login) before this. */
export class StepUpNeeded extends Error {
  constructor(public readonly reauth: boolean) {
    super(reauth ? "Sign in again to set up your first security factor" : "Confirm it's you first");
  }
}

export function usePasskey() {
  const [busy, setBusy] = useState(false);

  /** Registers a passkey. Throws StepUpNeeded when the server asks for a step-up or a fresh login first. */
  const enroll = useCallback(async (label?: string, headers: Record<string, string> = {}) => {
    setBusy(true);
    try {
      const opts = await post("/api/auth/passkey/register/options", undefined, headers);
      if (opts.status === 401 && opts.data?.stepUp) throw new StepUpNeeded(false);
      if (opts.status === 403 && opts.data?.reauth) throw new StepUpNeeded(true);
      if (!opts.ok) throw new Error(opts.data?.error || "Could not start registration");
      const attResp = await startRegistration({ optionsJSON: opts.data });
      const verify = await post("/api/auth/passkey/register/verify", { response: attResp, label });
      if (!verify.ok || !verify.data?.verified) throw new Error(verify.data?.error || "Passkey registration failed");
      return true;
    } finally {
      setBusy(false);
    }
  }, []);

  return { enroll, busy };
}
