"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useToast } from "@/hooks/use-toast";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { useStepUp, type Factor } from "@/components/StepUpProvider";

/**
 * The two code factors beside the passkey (Kev, 2026-10-07): an
 * authenticator app and a 6-digit code by email. Either one, once confirmed,
 * protects the same actions a passkey does. Setting one up is itself a
 * step-up when another factor exists; the first needs a fresh login.
 */
type Kind = "totp" | "email";
// The look of the panel's other inputs (the guardian field).
const field: React.CSSProperties = {
  height: 34, fontSize: 13, padding: "0 10px", border: "1px solid var(--enki-rule)",
  borderRadius: 6, background: "transparent", color: "var(--enki-ink)", outline: "none",
};

export default function CodeFactors({ onChange }: { onChange?: () => void }) {
  const { toast } = useToast();
  const { guarded } = useStepUp();
  const [setup, setSetup] = useState<{ kind: Kind; uri?: string; secret?: string } | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: factors, refetch: load } = useQuery({
    queryKey: ["stepup-factors"],
    queryFn: async () => {
      const res = await fetch("/api/auth/stepup", { headers: sessionAuthHeaders() });
      return res.ok ? (((await res.json()) as { factors: Factor[] }).factors ?? []) : [];
    },
  });

  const say = async (res: Response, fallback: string) => {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    toast({ title: body.error || fallback, variant: "destructive" });
  };

  const start = async (kind: Kind) => {
    setBusy(true);
    try {
      const res = await guarded("add-factor", (h) =>
        fetch(`/api/auth/mfa/${kind}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...sessionAuthHeaders(), ...h },
          body: JSON.stringify(kind === "email" ? { email } : {}),
        }),
      );
      if (!res.ok) return say(res, "Could not start the setup");
      const body = (await res.json()) as { uri?: string; secret?: string };
      setCode("");
      setSetup({ kind, uri: body.uri, secret: body.secret });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/mfa/${setup.kind}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) return say(res, "Wrong code");
      toast({ title: setup.kind === "totp" ? "Authenticator app added" : "Email code added" });
      setSetup(null);
      load();
      onChange?.();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (kind: Kind) => {
    const res = await guarded(`remove-factor:${kind}`, (h) =>
      fetch(`/api/auth/mfa/${kind}`, { method: "DELETE", headers: { ...sessionAuthHeaders(), ...h } }),
    );
    if (!res.ok) return say(res, "Could not remove it");
    toast({ title: "Removed" });
    load();
    onChange?.();
  };

  const row = (kind: Kind, title: string, sub: string) => {
    const on = factors?.includes(kind) ?? false;
    return (
      <div className="set-list-item">
        <div className="set-item-icon">{kind === "totp" ? <Smartphone size={14} /> : <Mail size={14} />}</div>
        <div className="set-item-content">
          <div className="set-item-title">
            {title}
            {on ? <span className="set-badge-good">✓ active</span> : null}
          </div>
          <div className="set-item-sub">{sub}</div>
          {!on && kind === "email" && setup?.kind !== "email" && (
            <input
              style={{ ...field, marginTop: 8, width: "100%" }}
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
          {setup?.kind === kind && (
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              {setup.uri && (
                <>
                  <QRCodeSVG value={setup.uri} size={148} />
                  <code style={{ fontSize: 11, wordBreak: "break-all" }}>{setup.secret}</code>
                </>
              )}
              <input
                style={field}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder={kind === "totp" ? "Code from the app" : "Code from the email"}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
              <button className="set-btn set-btn-dark" onClick={confirm} disabled={busy || code.length !== 6}>Confirm</button>
            </div>
          )}
        </div>
        {on ? (
          <button className="set-btn set-btn-outline" onClick={() => remove(kind)} disabled={busy}>Remove</button>
        ) : setup?.kind !== kind ? (
          <button className="set-btn set-btn-dark" onClick={() => start(kind)} disabled={busy || (kind === "email" && !email.includes("@"))}>
            Set up
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <>
      {row("totp", "Authenticator app", "A 6-digit code from Google Authenticator, Authy, 1Password or similar.")}
      {row("email", "Code by email", "A 6-digit code sent to an address you confirm once.")}
    </>
  );
}
