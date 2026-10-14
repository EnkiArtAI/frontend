"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Instagram, AlertCircle, ArrowUpRight, CheckCircle2, X } from "lucide-react";

import SettingsLayout from "@/components/settings/SettingsLayout";
import SettingsNav, { TabItem } from "@/components/settings/SettingsNav";
import SettingsSection from "@/components/settings/SettingsSection";
import SettingsToggle from "@/components/settings/SettingsToggle";
import PaymentPanel from "@/components/settings/PaymentPanel";
import RecoveryPanel from "@/components/settings/RecoveryPanel";
import LinkedWallets from "@/components/settings/LinkedWallets";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { useBetaAccess } from "@/components/BetaGate";
import { useRecoveryStatus } from "@/hooks/useRecoveryStatus";
import "@/components/settings/settings.css";

const TABS: TabItem[] = [
  { id: "profile", label: "Profile" },
  { id: "payment", label: "Payment" },
  { id: "recovery", label: "Recovery & 2FA" },
];

// The X (formerly Twitter) logo — lucide ships no brand X icon, so inline it.
function XLogo({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export default function SettingsPage({ initialTab, focusRamp = false, globalBannerVisible = false, focusGuardians: focusGuardiansProp = false, onBack }: { initialTab?: string; focusRamp?: boolean; globalBannerVisible?: boolean; focusGuardians?: boolean; onBack?: () => void } = {}) {
  const { toast } = useToast();
  const router = useRouter();
  // Back (Kev, 2026-10-13): the shell closes its panel; standalone /settings goes to the page before, or Home when there is none.
  const back = onBack ?? (() => (window.history.length > 1 ? router.back() : router.push("/home")));

  // initialTab lets embedders (sidebar balance chip → Payment) open a tab
  // directly; the URL deep-link below still wins when present.
  const [activeTab, setActiveTab] = useState(
    initialTab && TABS.some((t) => t.id === initialTab) ? initialTab : "profile"
  );
  // One-shot: the scroll+heartbeat fires only for the balance-chip entry.
  // Any manual tab click (including re-opening Payment) must not replay it.
  const [rampFocus, setRampFocus] = useState(focusRamp);
  // Slide the content pane left/right depending on which way the tab moved.
  const [slideDir, setSlideDir] = useState<"l" | "r">("r");
  // Pulse the Guardians area when Recovery is opened via the red banner.
  const [focusGuardians, setFocusGuardians] = useState(focusGuardiansProp);
  const changeTab = (t: string) => {
    const from = TABS.findIndex((x) => x.id === activeTab);
    const to = TABS.findIndex((x) => x.id === t);
    setSlideDir(to >= from ? "r" : "l");
    setRampFocus(false);
    setFocusGuardians(false); // plain tab clicks don't pulse
    setActiveTab(t);
  };

  // Red warning while the account has no confirmed recovery guardian.
  const recovery = useRecoveryStatus();
  /* Linked wallets are for an email account (Kev, 2026-10-08): a wallet
     account's own wallet would lose its remembered connection when the
     adapter disconnects after linking. The sections after it count on. */
  const { isAuthed: emailAuthed } = useEmailAuth();
  const no = (n: number) => String(n + (emailAuthed ? 1 : 0)).padStart(2, "0");

  // Leaderboard visibility — real flag (users.hide_from_leaderboard).
  const [hideLb, setHideLb] = useState<boolean | null>(null);
  // 18 or older (users.adult_confirmed_at); null until loaded.
  const [adult, setAdult] = useState<boolean | null>(null);
  const { setAdultConfirmed } = useBetaAccess();
  useEffect(() => {
    const headers = sessionAuthHeaders();
    if (Object.keys(headers).length === 0) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/users/handle", { headers });
        if (!res.ok) return;
        const d = (await res.json()) as { hideFromLeaderboard?: boolean; adultConfirmed?: boolean };
        if (!dead) { setHideLb(!!d.hideFromLeaderboard); setAdult(!!d.adultConfirmed); }
      } catch { /* leave null (toggle stays until loaded) */ }
    })();
    return () => { dead = true; };
  }, []);
  const toggleLeaderboard = async (showMe: boolean) => {
    const next = !showMe; // toggle shows "Show me", stored flag is "hide me"
    const prev = hideLb;
    setHideLb(next);
    try {
      const res = await fetch("/api/users/handle", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ hideFromLeaderboard: next }),
      });
      if (!res.ok) throw new Error();
      toast({ title: "Saved", description: next ? "You're hidden from the Hall of Fame." : "You'll appear on the Hall of Fame." });
    } catch {
      setHideLb(prev); // revert on failure
      toast({ title: "Couldn't save", variant: "destructive" });
    }
  };
  const toggleAdult = async (next: boolean) => {
    const prev = adult;
    setAdult(next);
    try {
      const res = await fetch("/api/users/handle", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ adultConfirmed: next }),
      });
      if (!res.ok) throw new Error();
      setAdultConfirmed(next);
      toast({ title: "Saved", description: next ? "The feed now offers an 18+ filter." : "18+ is hidden again." });
    } catch {
      setAdult(prev);
      toast({ title: "Couldn't save", variant: "destructive" });
    }
  };
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // --- Mock States ---
  const [settings, setSettings] = useState({
    showLeaderboardGen: true,
    showLeaderboardEarn: true,
  });
  const [initialSettings, setInitialSettings] = useState({
    showLeaderboardGen: true,
    showLeaderboardEarn: true,
  });

  // --- Change Detection ---
  useEffect(() => {
    const isDifferent = JSON.stringify(settings) !== JSON.stringify(initialSettings);
    setHasChanges(isDifferent);
  }, [settings, initialSettings]);

  // Deep-link support: /settings?tab=billing opens that tab directly (e.g. from
  // an "Add funds" entry point).
  useEffect(() => {
    if (typeof window === "undefined") return;
    let tab = new URLSearchParams(window.location.search).get("tab");
    // The Billing tab merged into Payment — old deep links (PayPal's redirect
    // back lands on ?tab=billing) keep working.
    if (tab === "billing") tab = "payment";
    if (tab && TABS.some((t) => t.id === tab)) setActiveTab(tab);
  }, []);

  const updateSetting = (key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    // Mock save delay
    await new Promise(r => setTimeout(r, 800));
    setInitialSettings(settings);
    setHasChanges(false);
    setSaving(false);
    toast({ title: "Settings saved", description: "Your preferences have been updated." });
  };

  // Connected social accounts. Empty until OAuth is wired (needs Kev's X/IG
  // developer app keys) — the compact UI already renders the connected state.
  type SocialAccount = { handle: string; avatar: string | null };
  const [socials, setSocials] = useState<{ x: SocialAccount | null; instagram: SocialAccount | null }>({ x: null, instagram: null });
  const connectSocial = (_network: "x" | "instagram") => {
    toast({ title: "Almost there", description: "Social connections are being switched on — this will go live shortly." });
  };
  const disconnectSocial = (network: "x" | "instagram") => {
    setSocials((s) => ({ ...s, [network]: null }));
    toast({ title: "Disconnected" });
  };

  // ── Delete account ──────────────────────────────────────────────────────
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deletePending, setDeletePending] = useState(false); // guardians notified
  const [deleteReq, setDeleteReq] = useState<{ id: string; key: string } | null>(null);
  const finishDelete = () => { try { localStorage.clear(); } catch { /* ignore */ } window.location.href = "/"; };
  const submitDelete = async () => {
    setDeleteBusy(true);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ confirm: deleteConfirm.trim().replace(/^@/, "") }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not delete");
      if (data.pending) {
        setDeleteReq({ id: data.requestId, key: data.ownerKey }); // start polling
        setDeletePending(true);
      } else {
        finishDelete(); // deleted immediately (no guardians)
      }
    } catch (e) {
      toast({ title: "Couldn't delete", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      setDeleteBusy(false);
    }
  };
  // While guardians approve, poll until the request finalizes → then sign out.
  useEffect(() => {
    if (!deleteReq) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/account/delete?id=${deleteReq.id}&key=${deleteReq.key}`);
        const d = await res.json();
        if (d.done) { clearInterval(t); finishDelete(); }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(t);
  }, [deleteReq]);

  // --- Render Helpers ---
  const titleMap: Record<string, React.ReactNode> = {
    profile: "Profile.",
    payment: "Payment.",
    recovery: <>Recovery <span>&</span> 2FA.</>,
  };

  const descMap: Record<string, string> = {
    profile: "Manage your connected social accounts, linked wallets and visibility settings.",
    payment: "Your balance, your earnings, and the ways money moves in and out — always into your own wallet.",
    recovery: "Keep more than one way back in — a passkey on another device, plus guardians you trust.",
  };

  // Real role lookup (users.role via session) — Admin section only for
  // admins/mods. Server-side admin APIs must re-check on their own.
  const [role, setRole] = useState<string>("user");
  useEffect(() => {
    const headers = sessionAuthHeaders();
    if (Object.keys(headers).length === 0) { setRole("user"); return; }
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/users/handle", { headers });
        if (!res.ok) return;
        const data = (await res.json()) as { role?: string };
        if (!dead && data.role) setRole(data.role);
      } catch { /* stay 'user' */ }
    })();
    return () => { dead = true; };
  }, []);
  const IS_ADMIN = role === "admin" || role === "mod";

  return (
    <>
      <div>
        <SettingsLayout
          onBack={back}
          breadcrumbs={`Settings > ${TABS.find(t => t.id === activeTab)?.label}`}
          title={titleMap[activeTab] || "Settings."}
          description={descMap[activeTab]}
        >
          {/* Persistent (no X) recovery warning — shown ONLY when the global
              top banner isn't already visible (else it's redundant). Inside
              Settings it can't be dismissed, only fixed. */}
          {!globalBannerVisible && recovery !== null && recovery.confirmed === 0 && (
            /* Whole strip is the button → same height on every tab (the old
               inline "Set it up" button changed the row height). */
            <div
              role="alert"
              onClick={() => { if (activeTab !== "recovery") { changeTab("recovery"); setFocusGuardians(true); } }}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                margin: "0 0 18px", padding: "12px 14px", borderRadius: 10,
                background: "#b3271e", color: "#fff", fontSize: 13, fontWeight: 600,
                cursor: activeTab !== "recovery" ? "pointer" : "default",
              }}
            >
              <span style={{ flex: 1 }}>
                No recovery set up. Lose this login and the account is gone.
              </span>
              {activeTab !== "recovery" && (
                <span style={{ fontSize: 12, fontWeight: 700, opacity: 0.9, whiteSpace: "nowrap" }}>Set it up →</span>
              )}
            </div>
          )}
          <SettingsNav
            tabs={TABS}
            activeTab={activeTab}
            onChange={changeTab}
          />

          {/* Keyed so a tab change replays the slide; direction follows the move. */}
          <div key={activeTab} className={`set-tabpane set-slide-${slideDir}`}>

          {/* === PROFILE TAB === */}
          {activeTab === "profile" && (
            <>
              <SettingsSection num="01" title="Connect social media profiles">
                <div className="set-section-desc" style={{ paddingBottom: 14, fontSize: 12.5 }}>
                  Link X and Instagram to share prompts to several places at once — post everywhere in one go, no copy-pasting each time.
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "flex-start" }}>
                  {([
                    { key: "x", label: "X", icon: <XLogo size={16} />, bg: "#000", account: socials.x },
                    { key: "instagram", label: "Instagram", icon: <Instagram size={18} />, bg: "linear-gradient(45deg,#f09433,#dc2743,#bc1888)", account: socials.instagram },
                  ] as const).map((s) => (
                    <div
                      key={s.key}
                      style={{
                        width: 108,
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 7,
                        border: "1px solid var(--enki-rule)", borderRadius: 10, padding: "12px 8px", textAlign: "center",
                      }}
                    >
                      <span className="set-item-icon" style={{ background: s.bg, color: "#fff", width: 36, height: 36, borderRadius: 10, marginRight: 0 }}>{s.icon}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--enki-ink)" }}>{s.label}</span>
                      {s.account ? (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, width: "100%" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--enki-ink)", maxWidth: "100%", overflow: "hidden" }}>
                            <CheckCircle2 size={12} style={{ color: "#1f8a5b", flexShrink: 0 }} />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>@{s.account.handle}</span>
                          </span>
                          <button
                            onClick={() => disconnectSocial(s.key)}
                            style={{ fontSize: 10.5, color: "var(--enki-ink-3)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
                          >
                            Disconnect
                          </button>
                        </div>
                      ) : (
                        <button className="set-btn set-btn-outline" style={{ height: 26, padding: "0 14px", fontSize: 12 }} onClick={() => connectSocial(s.key)}>
                          Connect
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </SettingsSection>

              {emailAuthed && <LinkedWallets num="02" />}

              <SettingsSection num={no(2)} title="Hall of Fame">
                <div className="set-list-item">
                  <div className="set-item-content">
                    <div className="set-item-title">Show me on the Hall of Fame</div>
                    <div className="set-item-sub">Appear in the public rankings for generations and earnings.</div>
                  </div>
                  <SettingsToggle
                    checked={hideLb === null ? true : !hideLb}
                    disabled={hideLb === null}
                    onChange={(c) => toggleLeaderboard(c)}
                  />
                </div>
              </SettingsSection>

              <SettingsSection num={no(3)} title="18+ content">
                <div className="set-list-item">
                  <div className="set-item-content">
                    <div className="set-item-title">I am 18 or older</div>
                    <div className="set-item-sub">Adds an 18+ filter to the feed, off until you turn it on, and lets you generate 18+ images. 18+ means sexual content; nudity alone is not 18+.</div>
                  </div>
                  <SettingsToggle
                    checked={adult === true}
                    disabled={adult === null}
                    onChange={(c) => toggleAdult(c)}
                  />
                </div>
              </SettingsSection>

              <SettingsSection num={no(4)} title="Danger Zone">
                <div className="set-list-item">
                  <div className="set-item-icon" style={{ color: '#e23b3b', background: '#ffebeb' }}><AlertCircle size={14} /></div>
                  <div className="set-item-content">
                    <div className="set-item-title" style={{ color: '#e23b3b' }}>Delete account</div>
                    <div className="set-item-sub">
                      {recovery && recovery.confirmed > 0
                        ? "Your guardians must approve this first. Everything you made is removed."
                        : "Permanently removes your account and everything you made. Can't be undone."}
                    </div>
                  </div>
                  <button className="set-btn set-btn-danger" onClick={() => setDeleteOpen(true)}>Delete account</button>
                </div>
              </SettingsSection>

              {IS_ADMIN && (
                <SettingsSection num={no(5)} title="Admin">
                  <div className="set-list-item">
                    <div className="set-item-icon" style={{ color: '#f5c542', background: '#fffaeb' }}>⚙</div>
                    <div className="set-item-content">
                      <div className="set-item-title">Admin Panel</div>
                      <div className="set-item-sub">Review imports, reports, feedback, and manage community trust. Only visible to admin wallets.</div>
                    </div>
                    <a href="/admin" className="set-btn set-btn-secondary" style={{ display: "flex", alignItems: "center", gap: 6, textDecoration: "none" }}>
                      Open Admin <ArrowUpRight size={12} />
                    </a>
                  </div>
                </SettingsSection>
              )}
            </>
          )}

          {/* === PAYMENT TAB === */}
          {activeTab === "payment" && <PaymentPanel focusRamp={rampFocus} />}

          {/* === RECOVERY & 2FA TAB === */}
          {activeTab === "recovery" && <RecoveryPanel focus={focusGuardians} />}

          </div>
        </SettingsLayout>
        
        {/* Floating Save Button */}
        <div className={`set-save-floater ${hasChanges ? 'visible' : ''}`}>
          <span>Unsaved changes</span>
          <button onClick={handleSaveSettings} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save Settings"}
          </button>
        </div>

        {/* ── Delete account confirm ── */}
        {deleteOpen && (
          <div className="set-pay-overlay" onClick={() => !deleteBusy && !deletePending && setDeleteOpen(false)}>
            <div className="set-pay-card set-pay-card--fiat" onClick={(e) => e.stopPropagation()}>
              {deletePending ? (
                <div style={{ textAlign: "center" }}>
                  <div className="set-item-title" style={{ marginBottom: 8 }}>Waiting for your guardians</div>
                  <p className="set-item-sub" style={{ marginBottom: 16 }}>
                    We emailed your guardians. Your account is deleted once enough of them approve. You can close this.
                  </p>
                  <button className="set-btn set-btn-outline" style={{ width: "100%", justifyContent: "center" }} onClick={() => { setDeleteOpen(false); setDeletePending(false); }}>
                    Close
                  </button>
                </div>
              ) : (
                <>
                  <div className="set-item-title" style={{ color: "#e23b3b", marginBottom: 6 }}>Delete your account?</div>
                  <p className="set-item-sub" style={{ marginBottom: 14 }}>
                    This removes your account and everything you made, for good.
                    {recovery && recovery.confirmed > 0
                      ? " Your guardians will be asked to approve before it happens."
                      : ""} Type your username to confirm.
                  </p>
                  <input
                    value={deleteConfirm}
                    onChange={(e) => setDeleteConfirm(e.target.value)}
                    placeholder="your_username"
                    autoFocus
                    style={{ width: "100%", height: 40, padding: "0 12px", borderRadius: 8, fontSize: 14, border: "1px solid var(--enki-rule)", background: "transparent", color: "var(--enki-ink)", outline: "none" }}
                  />
                  <button
                    className="set-btn set-btn-danger"
                    style={{ width: "100%", justifyContent: "center", marginTop: 14 }}
                    onClick={submitDelete}
                    disabled={deleteBusy || deleteConfirm.trim().length < 3}
                  >
                    {deleteBusy ? <Loader2 size={14} className="set-spin" /> : (recovery && recovery.confirmed > 0 ? "Request deletion" : "Delete forever")}
                  </button>
                  <button
                    className="set-btn set-btn-outline"
                    style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
                    onClick={() => setDeleteOpen(false)}
                    disabled={deleteBusy}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
