"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Key, Loader2, Mail, Users, Wallet, Smartphone, ShieldCheck, CheckCircle2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { usePasskey, StepUpNeeded } from "@/hooks/usePasskey";
import { useStepUp } from "@/components/StepUpProvider";
import { useQueryClient } from "@tanstack/react-query";
import { STEPUP_FACTORS_KEY, useStepUpFactors } from "@/hooks/useSecondFactor";
import { openLogin } from "@/lib/openLogin";
import CodeFactors from "@/components/settings/CodeFactors";
import { useToast } from "@/hooks/use-toast";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { refreshRecoveryStatus } from "@/hooks/useRecoveryStatus";
import SettingsSection from "@/components/settings/SettingsSection";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { requestCdpKeyExport } from "@/lib/cdp-bridge";
import { buildRecoveryFile, downloadRecoveryFile, openRecoveryFile } from "@/lib/recovery-file";

type GuardianKind = "wallet" | "email" | "authenticator" | "phone";
type AddType = GuardianKind;

interface Passkey {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}
interface Guardian {
  id: string;
  guardianType: GuardianKind;
  value: string;
  label: string | null;
  status: "pending" | "confirmed" | "unresponsive";
  inviteToken: string | null; // present while pending or unresponsive
  reminderCount?: number;
  manualRemindersLeft?: number;
  nextManualReminderAt?: string | null;
}

/**
 * Recovery & 2FA — everything here is live:
 *  - Passkeys (2FA): registered devices from webauthn_credentials, add/remove.
 *  - Guardians: trusted wallets/emails who can approve getting you back in.
 *    A wallet guardian confirms by signing a message on /guardian.
 */
// Module cache so re-opening the tab paints guardians INSTANTLY (the panel
// remounts on every open) while a fresh copy loads in the background.
let guardianCache: { guardians: Guardian[]; threshold: number } | null = null;

export default function RecoveryPanel({ focus = false }: { focus?: boolean } = {}) {
  const { toast } = useToast();
  const { enroll: enrollPasskey, busy: passkeyBusy } = usePasskey();
  const { guarded, tokenFor, confirm } = useStepUp();
  const queryClient = useQueryClient();
  const emailCodes = useStepUpFactors().data?.emailCodes ?? false;

  // When arrived here via the red "no recovery" banner: scroll the Guardians
  // area into view and pulse it (same heartbeat as the Payment "Add money").
  const guardiansRef = useRef<HTMLDivElement | null>(null);
  const [guardiansPulse, setGuardiansPulse] = useState(false);
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => {
      guardiansRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      setGuardiansPulse(true);
    }, 180);
    const off = setTimeout(() => setGuardiansPulse(false), 4200);
    return () => { clearTimeout(t); clearTimeout(off); };
  }, [focus]);

  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [guardians, setGuardians] = useState<Guardian[] | null>(guardianCache?.guardians ?? null);
  const [threshold, setThreshold] = useState(guardianCache?.threshold ?? 2);
  const [addType, setAddType] = useState<AddType>("wallet");
  const [addValue, setAddValue] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  // ── Recovery file ────────────────────────────────────────────────────────
  // Built and encrypted in the browser, handed straight to the download
  // manager. It is never uploaded and never mailed — a private key in transit
  // is a private key someone can intercept.
  const { address: cdpAddress } = useCdpAddress();
  const [filePw, setFilePw] = useState("");
  const [filePw2, setFilePw2] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [fileDone, setFileDone] = useState(false);

  const authed = Object.keys(sessionAuthHeaders()).length > 0;

  const makeRecoveryFile = async () => {
    setFileErr(null);
    if (filePw.length < 10) { setFileErr("Use at least 10 characters — this guards your wallet."); return; }
    if (filePw !== filePw2) { setFileErr("The two passphrases don't match."); return; }
    setFileBusy(true);
    try {
      // The user's own id: it is the mapping our database holds, so keeping it
      // in the file means we can re-link the account even if that database is
      // lost. Not a secret to its owner.
      const meRes = await fetch("/api/users/handle", { headers: sessionAuthHeaders() });
      const me = meRes.ok ? ((await meRes.json()) as { id?: string }) : {};
      if (!me.id) throw new Error("Could not confirm who you are — try signing in again.");

      // The key leaves the wallet only after a second factor, as in Payment.
      if (!(await confirm("export"))) return;
      const privateKey = await requestCdpKeyExport();
      const file = await buildRecoveryFile({
        privateKey,
        address: cdpAddress ?? "",
        userId: me.id,
        passphrase: filePw,
      });

      // Read it back before handing it over: nobody should walk away with a
      // backup that turns out to be unreadable.
      const check = await openRecoveryFile(file, filePw);
      if (check !== privateKey) throw new Error("The file failed its own check — nothing was saved.");

      downloadRecoveryFile(file);
      setFileDone(true);
      setFilePw("");
      setFilePw2("");
      toast({ title: "Recovery file saved", description: "Keep it somewhere safe and offline." });
    } catch (e) {
      setFileErr(e instanceof Error ? e.message : "Could not create the file");
    } finally {
      setFileBusy(false);
    }
  };

  const loadPasskeys = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/passkey/credentials", { headers: sessionAuthHeaders() });
      if (res.ok) setPasskeys(((await res.json()) as { credentials: Passkey[] }).credentials);
      else setPasskeys([]);
    } catch { setPasskeys([]); }
  }, []);

  const loadGuardians = useCallback(async () => {
    try {
      const res = await fetch("/api/recovery/guardians", { headers: sessionAuthHeaders() });
      if (res.ok) {
        const data = (await res.json()) as { guardians: Guardian[]; threshold: number };
        guardianCache = { guardians: data.guardians, threshold: data.threshold };
        setGuardians(data.guardians);
        setThreshold(data.threshold);
      } else setGuardians([]);
    } catch { setGuardians([]); }
    refreshRecoveryStatus(); // keep the red "no recovery" banners in sync
  }, []);

  useEffect(() => {
    if (!authed) { setPasskeys([]); setGuardians([]); return; }
    loadPasskeys();
    loadGuardians();
  }, [authed, loadPasskeys, loadGuardians]);

  const handleAddPasskey = async () => {
    const label = typeof navigator !== "undefined" ? navigator.platform || "This device" : undefined;
    try {
      try {
        await enrollPasskey(label);
      } catch (e) {
        // A further factor is a step-up; the first one needs a fresh login.
        if (!(e instanceof StepUpNeeded) || e.reauth) throw e;
        const token = await tokenFor("add-factor");
        if (!token) return;
        await enrollPasskey(label, { "X-StepUp-Token": token });
      }
      toast({ title: "Passkey added", description: "We'll ask for it before risky actions." });
      loadPasskeys();
      void queryClient.invalidateQueries({ queryKey: STEPUP_FACTORS_KEY });
    } catch (e) {
      // The first factor needs a login younger than ten minutes: offer it here.
      if (e instanceof StepUpNeeded && e.reauth) openLogin();
      const msg = e instanceof Error ? e.message : "Could not add passkey";
      if (!/cancel|abort|NotAllowed/i.test(msg)) toast({ title: "Couldn't add passkey", description: msg, variant: "destructive" });
    }
  };

  const removePasskey = async (id: string) => {
    const res = await guarded(`remove-factor:${id}`, (h) => fetch("/api/auth/passkey/credentials", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },
      body: JSON.stringify({ id }),
    }));
    if (res.ok) { toast({ title: "Passkey removed" }); loadPasskeys(); void queryClient.invalidateQueries({ queryKey: STEPUP_FACTORS_KEY }); }
    else toast({ title: "Couldn't remove passkey", variant: "destructive" });
  };

  // Authenticator setup modal (QR + code entry) after adding that type.
  const [totpSetup, setTotpSetup] = useState<{ guardianId: string; secret: string; otpauthUri: string } | null>(null);

  const addGuardian = async () => {
    const needsValue = addType !== "authenticator";
    const value = addValue.trim();
    if (needsValue && !value) return;
    setAddBusy(true);
    try {
      const res = await guarded("guardians", (h) => fetch("/api/recovery/guardians", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },
        body: JSON.stringify(addType === "authenticator" ? { guardianType: "authenticator" } : { guardianType: addType, value }),
      }));
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not add guardian");
      setAddValue("");
      if (data.setup) {
        setTotpSetup(data.setup); // open the QR/verify modal
      } else if (data.phoneSetup) {
        setPhoneSetup({ guardianId: data.phoneSetup.guardianId, phone: data.phoneSetup.phone });
        setResendAt(new Date(data.phoneSetup.resendAvailableAt).getTime());
      } else {
        toast({
          title: "Guardian added",
          description: data.emailed
            ? "We emailed them their invite. They show as Confirmed once they accept."
            : addType === "email"
              ? "Couldn't send the email — use Copy link and send it to them yourself."
              : "Send them their confirmation link (Copy link).",
        });
      }
      loadGuardians();
    } catch (e) {
      toast({ title: "Couldn't add guardian", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally { setAddBusy(false); }
  };

  const [totpCode, setTotpCode] = useState("");
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpErr, setTotpErr] = useState<string | null>(null);
  const [totpDone, setTotpDone] = useState(false);
  const verifyTotpSetup = async () => {
    if (!totpSetup) return;
    setTotpBusy(true); setTotpErr(null);
    try {
      const res = await fetch("/api/recovery/guardians", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ verifyId: totpSetup.guardianId, code: totpCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "That code isn't right.");
      setTotpDone(true); // green check inside the modal — closes via Done
      loadGuardians();
    } catch (e) {
      setTotpErr(e instanceof Error ? e.message : "That code isn't right.");
    } finally { setTotpBusy(false); }
  };
  const closeTotpSetup = () => {
    // A pending authenticator stays on the list; verify later via "Verify"
    // or remove it. Just close.
    setTotpSetup(null); setTotpCode(""); setTotpErr(null); setTotpDone(false); loadGuardians();
  };

  // ── Phone (SMS) setup modal ──
  const [phoneSetup, setPhoneSetup] = useState<{ guardianId: string; phone: string } | null>(null);
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [phoneDone, setPhoneDone] = useState(false);
  const [resendAt, setResendAt] = useState(0);       // ms; when resend is allowed
  const [bannedUntil, setBannedUntil] = useState(0); // ms; hard block
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!phoneSetup) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phoneSetup]);
  const closePhoneSetup = () => {
    // Reset every code/cooldown bit of client state on close, as requested.
    setPhoneSetup(null); setPhoneCode(""); setPhoneErr(null); setPhoneDone(false);
    setResendAt(0); setBannedUntil(0); loadGuardians();
  };
  const verifyPhone = async () => {
    if (!phoneSetup) return;
    setPhoneBusy(true); setPhoneErr(null);
    try {
      const res = await fetch("/api/recovery/guardians", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ phoneVerifyId: phoneSetup.guardianId, code: phoneCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "That code isn't right.");
      setPhoneDone(true);
      loadGuardians();
    } catch (e) {
      setPhoneErr(e instanceof Error ? e.message : "That code isn't right.");
    } finally { setPhoneBusy(false); }
  };
  const resendPhone = async () => {
    if (!phoneSetup) return;
    setPhoneBusy(true); setPhoneErr(null);
    try {
      const res = await fetch("/api/recovery/guardians", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ phoneResendId: phoneSetup.guardianId }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.resendAvailableAt) setResendAt(new Date(data.resendAvailableAt).getTime());
        if (data.bannedUntil) setBannedUntil(new Date(data.bannedUntil).getTime());
        toast({ title: "Code sent" });
      } else {
        if (data.bannedUntil) setBannedUntil(new Date(data.bannedUntil).getTime());
        if (data.resendAvailableAt) setResendAt(new Date(data.resendAvailableAt).getTime());
        setPhoneErr(data?.error || "Please wait before trying again.");
      }
    } catch {
      setPhoneErr("Couldn't resend — try again.");
    } finally { setPhoneBusy(false); }
  };

  // Removing is confirmed in a dialog first — and the removed email guardian
  // gets a goodbye mail from the server.
  const [removeAsk, setRemoveAsk] = useState<Guardian | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const removeGuardian = async (id: string) => {
    setRemoveBusy(true);
    try {
      const res = await guarded("guardians", (h) => fetch(`/api/recovery/guardians?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { ...sessionAuthHeaders(), ...h },
      }));
      if (res.ok) { toast({ title: "Guardian removed", description: "If they were an email guardian, we let them know." }); loadGuardians(); }
      else toast({ title: "Couldn't remove guardian", variant: "destructive" });
    } catch {
      toast({ title: "Couldn't remove guardian", description: "Check your connection and try again.", variant: "destructive" });
    } finally {
      setRemoveBusy(false);
      setRemoveAsk(null);
    }
  };

  const saveThreshold = async (n: number) => {
    setThreshold(n);
    const res = await guarded("guardians", (h) => fetch("/api/recovery/guardians", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },
      body: JSON.stringify({ threshold: n }),
    }));
    if (res.ok) toast({ title: "Saved", description: `${n} guardian${n === 1 ? "" : "s"} must approve a recovery.` });
    else toast({ title: "Couldn't save threshold", variant: "destructive" });
  };

  const [remindBusy, setRemindBusy] = useState<string | null>(null);
  /* Re-render when the earliest reminder cooldown expires, so the green
     "Reminder sent" state flips back to an active button by itself instead
     of waiting for a reload. */
  const [remindTick, setRemindTick] = useState(0);
  useEffect(() => {
    const next = (guardians ?? [])
      .map((g) => (g.nextManualReminderAt ? Date.parse(g.nextManualReminderAt) : NaN))
      .filter((t) => Number.isFinite(t) && t > Date.now());
    if (!next.length) return;
    const t = window.setTimeout(() => setRemindTick((x) => x + 1), Math.min(...next) - Date.now() + 500);
    return () => window.clearTimeout(t);
    /* remindTick in the deps re-runs this after each firing, so the NEXT
       earliest expiry gets its own timer — one-shot left every later
       guardian stuck on green past its unlock (found by review). */
  }, [guardians, remindTick]);
  const sendReminder = async (guardianId: string) => {
    setRemindBusy(guardianId);
    try {
      const res = await fetch("/api/recovery/guardians/remind", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ guardianId }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        toast({
          title: "Reminder sent",
          description: `${d.remindersLeft ?? "?"} of 7 reminders left for this guardian.`,
        });
      } else {
        toast({ title: "Couldn't send the reminder", description: d.error, variant: "destructive" });
      }
      // Either way the server state moved (or told us why not) — re-read it so
      // the button's disabled state stays the server's answer, not our guess.
      loadGuardians();
    } finally {
      setRemindBusy(null);
    }
  };

  const copyInvite = async (g: Guardian) => {
    if (!g.inviteToken) return;
    const url = `${window.location.origin}/guardian?token=${encodeURIComponent(g.inviteToken)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Link copied", description: "Send it to your guardian — they confirm on that page." });
    } catch { toast({ title: "Copy failed", variant: "destructive" }); }
  };

  // Only CONFIRMED guardians count — pending invites can't approve anything,
  // so the threshold is capped by (and displayed against) the confirmed set.
  const confirmedCount = guardians?.filter((g) => g.status === "confirmed").length ?? 0;
  const maxThreshold = Math.max(confirmedCount, 1);

  // The dropdown only offers reachable values (1..confirmed); the server caps
  // the stored threshold the same way (lib/recovery/threshold.ts), so saving
  // the cap here would only ask for a step-up nobody started.

  const reInvite = async (id: string) => {
    const res = await fetch("/api/recovery/guardians", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ reinviteId: id }),
    });
    if (res.ok) { toast({ title: "Invite re-sent", description: "We emailed them a fresh invite." }); loadGuardians(); }
    else toast({ title: "Couldn't re-invite", variant: "destructive" });
  };

  if (!authed) {
    return (
      <SettingsSection num="01" title="Sign in first">
        <div className="set-section-desc" style={{ paddingBottom: 20 }}>
          Recovery settings belong to your account — log in to see and change them.
        </div>
      </SettingsSection>
    );
  }

  return (
    <>
      {/* ── 01 · Passkeys (2FA) ── */}
      <SettingsSection num="01" title="Two-step check (2FA)">
        <div className="set-section-desc" style={{ paddingBottom: 16 }}>
          A passkey is the fingerprint, face or PIN lock of one of your devices, used for this site.
          An authenticator app works too{emailCodes ? ", and so does a code by email" : ""}. Add any of
          them and we&apos;ll ask for one before anything serious happens: using your wallet, deleting
          your work, changing these factors or your guardians.
        </div>
        <div className="set-list-item set-soft">
          <div className="set-item-icon"><Key size={14} /></div>
          <div className="set-item-content">
            <div className="set-item-title">
              Your passkeys
              {passkeys && passkeys.length > 0
                ? <span className="set-badge-good">✓ {passkeys.length} active</span>
                : <span className="set-badge-warn">None yet</span>}
            </div>
            <div className="set-item-sub">Each one is a device that can confirm it&apos;s really you.</div>
          </div>
          <button className="set-btn set-btn-dark" onClick={handleAddPasskey} disabled={passkeyBusy}>
            {passkeyBusy ? "Waiting…" : "+ Add a passkey"}
          </button>
        </div>
        {passkeys === null ? (
          <div className="set-list-item"><Loader2 size={14} className="set-spin" /></div>
        ) : (
          passkeys.map((p) => (
            <div key={p.id} className="set-list-item">
              <div className="set-item-icon"><Key size={14} /></div>
              <div className="set-item-content">
                <div className="set-item-title">{p.deviceLabel || "Passkey"}</div>
                <div className="set-item-sub">
                  Added {new Date(p.createdAt).toLocaleDateString()}
                  {p.lastUsedAt ? ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ""}
                </div>
              </div>
              <button className="set-btn set-btn-outline" onClick={() => removePasskey(p.id)}>Remove</button>
            </div>
          ))
        )}
        <CodeFactors />
      </SettingsSection>

      {/* ── 02 · Guardians ── */}
      <div ref={guardiansRef} className={guardiansPulse ? "set-heartbeat--red" : undefined}>
      <SettingsSection num="02" title="Guardians">
        <div className="set-section-desc" style={{ paddingBottom: 16 }}>
          Guardians are accounts that can help you back in if you ever get locked out — a wallet or email
          you trust. They can even be your own (a second email or wallet). Enough of them approving is what
          unlocks your account. Wallet guardians confirm by signing; email guardians confirm via their link.
        </div>

        <div className="set-list-item set-soft" style={{ gap: 8 }}>
          <select
            className="set-btn set-btn-secondary"
            style={{ outline: "none" }}
            value={addType}
            onChange={(e) => setAddType(e.target.value as AddType)}
          >
            <option value="wallet">Wallet</option>
            <option value="email">Email</option>
            <option value="authenticator">Authenticator</option>
            {/* Phone (SMS) hidden — needs a paid SMS provider; Authenticator
                gives the same own-device factor for free. Server code stays,
                re-enable by restoring this option. */}
          </select>
          {addType !== "authenticator" && (
            <input
              className="set-amount-wrap"
              style={{ flex: 1, height: 34, fontSize: 13, padding: "0 10px", border: "1px solid var(--enki-rule)", borderRadius: 6, background: "transparent", color: "var(--enki-ink)", outline: "none" }}
              placeholder={addType === "wallet" ? "Guardian's Solana address" : "guardian@email.com"}
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addGuardian(); }}
            />
          )}
          {addType === "authenticator" && (
            <div className="set-item-sub" style={{ flex: 1 }}>Set up a code from your authenticator app.</div>
          )}
          <button className="set-btn set-btn-dark" onClick={addGuardian} disabled={addBusy || (addType !== "authenticator" && !addValue.trim())}>
            {addBusy ? <Loader2 size={14} className="set-spin" /> : addType === "authenticator" ? "Set up" : "+ Add"}
          </button>
        </div>

        {guardians === null ? (
          <div className="set-list-item"><Loader2 size={14} className="set-spin" /></div>
        ) : guardians.length === 0 ? (
          <div className="set-list-item">
            <div className="set-item-sub">No guardians yet. Two or three trusted people is a good start.</div>
          </div>
        ) : (
          guardians.map((g) => {
            const icon = g.guardianType === "wallet" ? <Wallet size={14} />
              : g.guardianType === "authenticator" ? <ShieldCheck size={14} />
              : g.guardianType === "phone" ? <Smartphone size={14} />
              : <Mail size={14} />;
            const sub = g.status === "unresponsive"
              ? "Didn't answer after 3 reminders — re-invite to try again."
              : g.guardianType === "wallet" ? "Confirms by signing with this wallet"
              : g.guardianType === "authenticator" ? "Confirms with a code from your authenticator app"
              : g.guardianType === "phone" ? "Text-message verification is coming soon"
              : "Confirms via the link in their email";
            return (
            <div key={g.id} className="set-list-item">
              <div className="set-item-icon">{icon}</div>
              <div className="set-item-content">
                <div className="set-item-title" style={{ fontFamily: g.guardianType === "wallet" ? "monospace" : undefined, fontSize: g.guardianType === "wallet" ? 12 : 14 }}>
                  {g.guardianType === "wallet" ? `${g.value.slice(0, 6)}…${g.value.slice(-6)}` : g.value}
                  {g.status === "confirmed"
                    ? <span className="set-badge-good">✓ Confirmed</span>
                    : g.status === "unresponsive"
                      ? <span className="set-badge-muted">No response</span>
                      : <span className="set-badge-warn">Pending</span>}
                </div>
                <div className="set-item-sub">{sub}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {g.status === "pending" && g.guardianType === "authenticator" && (
                  <button className="set-btn set-btn-dark" onClick={() => setTotpSetup({ guardianId: g.id, secret: "", otpauthUri: "" })}>Verify</button>
                )}
                {g.status === "pending" && g.guardianType === "phone" && (
                  <button className="set-btn set-btn-dark" onClick={() => { setPhoneSetup({ guardianId: g.id, phone: g.value }); setResendAt(0); }}>Verify</button>
                )}
                {g.status === "unresponsive" && (
                  <button className="set-btn set-btn-dark" onClick={() => reInvite(g.id)}>Re-invite</button>
                )}
                {g.status === "pending" && g.guardianType === "email" && (() => {
                  /* Disabled states mirror what the remind route would answer,
                     so the button never clicks into a 429. The limits protect
                     the guardian — a stranger who never asked for the role —
                     which is why they live on the server and this only reads
                     them. */
                  const left = g.manualRemindersLeft ?? 0;
                  const readyAt = g.nextManualReminderAt ? Date.parse(g.nextManualReminderAt) : 0;
                  const cooling = Number.isFinite(readyAt) && readyAt > Date.now();
                  const disabled = remindBusy === g.id || left <= 0 || cooling;
                  const title = left <= 0
                    ? "All 7 reminders for this guardian have been used"
                    : cooling
                      ? `A reminder went out in the last 24 hours — next one ${new Date(readyAt).toLocaleString()}`
                      : `${left} of 7 reminders left`;
                  /* While the 24h cooldown runs the button itself says so in
                     green — "Reminder sent" with a check — and the tiny line
                     under it names the moment the next one unlocks (Kev,
                     2026-08-22). */
                  const sent = cooling && left > 0;
                  return (
                    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                      <button className={"set-btn set-btn-outline" + (sent ? " set-btn-sent" : "")} disabled={disabled} title={title} onClick={() => sendReminder(g.id)}>
                        {remindBusy === g.id ? "Sending…" : sent ? <><CheckCircle2 size={12} aria-hidden /> Reminder sent</> : "Send reminder"}
                      </button>
                      {sent && <span className="set-remind-next">Next reminder available {new Date(readyAt).toLocaleString()}</span>}
                    </span>
                  );
                })()}
                {g.status === "pending" && (g.guardianType === "email" || g.guardianType === "wallet") && (
                  <button className="set-btn set-btn-outline" onClick={() => copyInvite(g)}>Copy link</button>
                )}
                <button className="set-btn set-btn-outline" onClick={() => setRemoveAsk(g)}>Remove</button>
              </div>
            </div>
            );
          })
        )}
        <div className="set-section-desc" style={{ fontSize: 12, paddingTop: 4 }}>
          We remind pending email guardians every 14 days, up to 3 times, then mark them “No response”.
        </div>

        <div className="set-list-item">
          <div className="set-item-icon"><Users size={14} /></div>
          <div className="set-item-content">
            <div className="set-item-title">How many must approve</div>
            <div className="set-item-sub">
              {confirmedCount === 0
                ? "Takes effect once your guardians have confirmed."
                : `${confirmedCount} of your guardians ${confirmedCount === 1 ? "has" : "have"} confirmed so far.`}
            </div>
          </div>
          <select
            className="set-btn set-btn-secondary"
            style={{ outline: "none" }}
            // Only reachable options (1..confirmed) — the effect above already
            // clamped+persisted any stored value above the confirmed count.
            value={confirmedCount === 0 ? 1 : Math.min(threshold, maxThreshold)}
            onChange={(e) => saveThreshold(Number(e.target.value))}
            disabled={confirmedCount === 0}
          >
            {confirmedCount === 0 ? (
              <option value={1}>Waiting for confirmations</option>
            ) : (
              Array.from({ length: maxThreshold }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n} of {confirmedCount}</option>
              ))
            )}
          </select>
        </div>

      </SettingsSection>
      </div>

      {/* ── 03 · Recovery file — the parachute ── */}
      <SettingsSection num="03" title="Recovery file">
        <div className="set-section-desc" style={{ paddingBottom: 14 }}>
          Guardians and 2FA get you back into <em>this</em> account. A recovery file is different:
          it holds your wallet key itself, so you can reach your money with any Solana wallet —
          even if you lose access here, or if Enki disappears entirely. Download it once, keep it
          offline. It is created on your device and never sent anywhere.
        </div>

        {!cdpAddress ? (
          <div className="set-list-item">
            <div className="set-item-content">
              <div className="set-item-title">No embedded wallet yet</div>
              <div className="set-item-sub">
                Sign in with email and your wallet is created automatically — then this file becomes available.
              </div>
            </div>
          </div>
        ) : (
          <div style={{ padding: "0 24px 20px" }}>
            <div style={{ display: "grid", gap: 10, maxWidth: 420 }}>
              <div>
                <label className="set-item-sub" htmlFor="rf-pw">Choose a passphrase</label>
                <input
                  id="rf-pw"
                  type="password"
                  autoComplete="new-password"
                  value={filePw}
                  onChange={(e) => { setFilePw(e.target.value); setFileErr(null); }}
                  placeholder="At least 10 characters"
                  style={{ height: 34, fontSize: 13, padding: "0 10px", border: "1px solid var(--enki-rule)", borderRadius: 6, background: "transparent", color: "var(--enki-ink)", outline: "none", width: "100%" }}
                />
              </div>
              <div>
                <label className="set-item-sub" htmlFor="rf-pw2">Repeat it</label>
                <input
                  id="rf-pw2"
                  type="password"
                  autoComplete="new-password"
                  value={filePw2}
                  onChange={(e) => { setFilePw2(e.target.value); setFileErr(null); }}
                  style={{ height: 34, fontSize: 13, padding: "0 10px", border: "1px solid var(--enki-rule)", borderRadius: 6, background: "transparent", color: "var(--enki-ink)", outline: "none", width: "100%" }}
                />
              </div>

              {fileErr && <div className="set-item-sub" style={{ color: "#b3271e" }}>{fileErr}</div>}

              <button
                className="set-btn set-btn-dark"
                onClick={() => void makeRecoveryFile()}
                disabled={fileBusy || !filePw || !filePw2}
                style={{ justifySelf: "start" }}
              >
                {fileBusy ? <Loader2 size={14} className="set-spin" /> : "Download recovery file"}
              </button>

              {fileDone && (
                <div className="set-item-sub" style={{ display: "flex", gap: 6, alignItems: "center", color: "#1f8a5b" }}>
                  <CheckCircle2 size={14} /> Saved. Store it offline — a copy on the same laptop protects you from very little.
                </div>
              )}

              <div className="set-item-sub" style={{ marginTop: 4 }}>
                Forgetting this passphrase is not a lockout — you keep signing in as usual.
                You would only lose the file, and can make a new one any time.
              </div>
            </div>
          </div>
        )}
      </SettingsSection>

      {/* ── Remove guardian: are you sure? ── */}
      {removeAsk && (
        <div className="set-pay-overlay" onClick={() => !removeBusy && setRemoveAsk(null)}>
          <div className="set-pay-card set-pay-card--fiat" onClick={(e) => e.stopPropagation()}>
            <div className="set-item-title" style={{ marginBottom: 6 }}>Remove this guardian?</div>
            <p className="set-item-sub" style={{ marginBottom: 16, wordBreak: "break-all" }}>
              {removeAsk.guardianType === "wallet"
                ? `${removeAsk.value.slice(0, 6)}…${removeAsk.value.slice(-6)}`
                : removeAsk.value}{" "}
              won&apos;t be able to help you recover this account anymore.
              {removeAsk.guardianType === "email" ? " We'll send them a short note." : ""}
            </p>
            <button
              className="set-btn set-btn-dark"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={() => removeGuardian(removeAsk.id)}
              disabled={removeBusy}
            >
              {removeBusy ? <Loader2 size={14} className="set-spin" /> : "Yes, remove"}
            </button>
            <button
              className="set-btn set-btn-outline"
              style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
              onClick={() => setRemoveAsk(null)}
              disabled={removeBusy}
            >
              Keep them
            </button>
          </div>
        </div>
      )}

      {/* ── Authenticator setup / verify ── */}
      {totpSetup && (
        <div className="set-pay-overlay" onClick={() => !totpBusy && closeTotpSetup()}>
          <div className="set-pay-card set-pay-card--fiat" onClick={(e) => e.stopPropagation()}>
            {totpDone ? (
              /* Success — same green check as the login screen. */
              <div style={{ textAlign: "center", padding: "8px 0" }}>
                <CheckCircle2 size={48} style={{ color: "#1f8a5b", margin: "0 auto 12px" }} />
                <div className="set-item-title" style={{ marginBottom: 6 }}>Authenticator connected</div>
                <p className="set-item-sub" style={{ marginBottom: 18 }}>
                  It&apos;s linked and confirmed. You can use it to help recover your account.
                </p>
                <button className="set-btn set-btn-dark" style={{ width: "100%", justifyContent: "center" }} onClick={closeTotpSetup}>
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="set-item-title" style={{ marginBottom: 6 }}>
                  {totpSetup.otpauthUri ? "Set up your authenticator" : "Enter your authenticator code"}
                </div>
                {totpSetup.otpauthUri && (
                  <>
                    <p className="set-item-sub" style={{ marginBottom: 12 }}>
                      Scan the QR with your authenticator app (Google Authenticator, Authy, 1Password…), or paste the key. Then type the 6-digit code it shows.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 14 }}>
                      <div style={{ background: "#fff", padding: 10, borderRadius: 12 }}>
                        <QRCodeSVG value={totpSetup.otpauthUri} size={172} level="M" />
                      </div>
                      <div style={{ width: "100%" }}>
                        <div className="mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--enki-ink-3)", marginBottom: 5, textAlign: "center" }}>Or paste this key</div>
                        <code style={{ display: "block", padding: "10px 12px", borderRadius: 8, fontSize: 13, letterSpacing: 1.5, wordBreak: "break-all", textAlign: "center", userSelect: "all", border: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)", color: "var(--enki-ink)" }}>
                          {totpSetup.secret}
                        </code>
                      </div>
                    </div>
                  </>
                )}
                {!totpSetup.otpauthUri && (
                  <p className="set-item-sub" style={{ marginBottom: 12 }}>Open your authenticator app and type the current 6-digit code for Enki Art.</p>
                )}
                <input
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => { if (e.key === "Enter" && totpCode.length === 6) verifyTotpSetup(); }}
                  placeholder="123456"
                  inputMode="numeric"
                  autoFocus
                  style={{ width: "100%", height: 44, padding: "0 12px", borderRadius: 8, fontSize: 22, letterSpacing: 8, textAlign: "center", border: "1px solid var(--enki-rule)", background: "transparent", color: "var(--enki-ink)", outline: "none" }}
                />
                {totpErr && <p style={{ fontSize: 12.5, color: "#e0584f", marginTop: 8 }}>{totpErr}</p>}
                <button className="set-btn set-btn-dark" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} onClick={verifyTotpSetup} disabled={totpBusy || totpCode.length !== 6}>
                  {totpBusy ? <Loader2 size={14} className="set-spin" /> : "Confirm"}
                </button>
                <button className="set-btn set-btn-outline" style={{ width: "100%", justifyContent: "center", marginTop: 8 }} onClick={closeTotpSetup} disabled={totpBusy}>
                  Later
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Phone (SMS) verification ── */}
      {phoneSetup && (() => {
        const resendSecs = Math.max(0, Math.ceil((resendAt - nowTick) / 1000));
        const banSecs = Math.max(0, Math.ceil((bannedUntil - nowTick) / 1000));
        const banText = banSecs > 3600 ? `${Math.ceil(banSecs / 3600)}h` : banSecs > 60 ? `${Math.ceil(banSecs / 60)}m` : `${banSecs}s`;
        const canResend = !phoneBusy && banSecs === 0 && resendSecs === 0;
        return (
        <div className="set-pay-overlay" onClick={() => !phoneBusy && closePhoneSetup()}>
          <div className="set-pay-card set-pay-card--fiat" onClick={(e) => e.stopPropagation()}>
            {phoneDone ? (
              <div style={{ textAlign: "center", padding: "8px 0" }}>
                <CheckCircle2 size={48} style={{ color: "#1f8a5b", margin: "0 auto 12px" }} />
                <div className="set-item-title" style={{ marginBottom: 6 }}>Number confirmed</div>
                <p className="set-item-sub" style={{ marginBottom: 18 }}>Your phone can now help recover your account.</p>
                <button className="set-btn set-btn-dark" style={{ width: "100%", justifyContent: "center" }} onClick={closePhoneSetup}>Done</button>
              </div>
            ) : (
              <>
                <div className="set-item-title" style={{ marginBottom: 6 }}>Enter the code we texted you</div>
                <p className="set-item-sub" style={{ marginBottom: 12 }}>
                  We sent a 6-digit code to <strong>{phoneSetup.phone}</strong>. Type it below.
                </p>
                <input
                  value={phoneCode}
                  onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => { if (e.key === "Enter" && phoneCode.length === 6) verifyPhone(); }}
                  placeholder="123456"
                  inputMode="numeric"
                  autoFocus
                  style={{ width: "100%", height: 44, padding: "0 12px", borderRadius: 8, fontSize: 22, letterSpacing: 8, textAlign: "center", border: "1px solid var(--enki-rule)", background: "transparent", color: "var(--enki-ink)", outline: "none" }}
                />
                {phoneErr && <p style={{ fontSize: 12.5, color: "#e0584f", marginTop: 8 }}>{phoneErr}</p>}
                <button className="set-btn set-btn-dark" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} onClick={verifyPhone} disabled={phoneBusy || phoneCode.length !== 6}>
                  {phoneBusy ? <Loader2 size={14} className="set-spin" /> : "Confirm"}
                </button>
                <button
                  className="set-btn set-btn-outline"
                  style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
                  onClick={resendPhone}
                  disabled={!canResend}
                >
                  {banSecs > 0 ? `Too many tries — wait ${banText}` : resendSecs > 0 ? `Resend SMS code (${resendSecs}s)` : "Resend SMS code"}
                </button>
                <button className="set-btn" style={{ width: "100%", justifyContent: "center", marginTop: 8, background: "transparent", color: "var(--enki-ink-3)", border: "none" }} onClick={closePhoneSetup} disabled={phoneBusy}>
                  Later
                </button>
              </>
            )}
          </div>
        </div>
        );
      })()}
    </>
  );
}
