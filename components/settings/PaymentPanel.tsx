"use client";

import { useEffect, useRef, useState } from "react";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ArrowDownToLine, ArrowLeft, ArrowUpFromLine, ChevronDown, Copy, Loader2 } from "lucide-react";

import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useSolanaAuth } from "@/hooks/useSolanaAuth";
import { useHoldings } from "@/hooks/useHoldings";
import { useToast } from "@/hooks/use-toast";
import { sessionAuthHeaders } from "@/lib/session-headers";
import SettingsSection from "@/components/settings/SettingsSection";
import BillingPanel from "@/components/settings/BillingPanel";

interface Earnings {
  earnings: { total: number; thisMonth: number };
  sales: { total: number };
}

// The panel remounts on every menu click — the last response is kept at
// module level so earnings paint instantly and refresh in the background.
let earningsCache: Earnings | null = null;

type RampSide = "buy" | "sell";
type RampProvider = "coinbase" | "moonpay";

// Facts a chooser needs — enough to decide at a glance, nothing more.
const RAMPS: { id: RampProvider; name: string; logo: string; logoBg: string; buySub: string; sellSub: string }[] = [
  { id: "coinbase", name: "Coinbase", logo: "C", logoBg: "#0052ff", buySub: "From ~$5 · card & Apple Pay", sellSub: "To your bank account · usually minutes" },
  { id: "moonpay", name: "MoonPay", logo: "M", logoBg: "#7d00ff", buySub: "From ~$20 · card, PayPal & more", sellSub: "To your bank, card or PayPal" },
];

/**
 * Payment — the money page. Your balance up top (with a plain-words wallet
 * explainer), one "Move money" card whose Add money / Pay out tiles expand
 * into a provider chooser (Coinbase live, MoonPay greyed until its keys
 * exist), deposit-crypto for wallet users, and the networks at the bottom.
 */
export default function PaymentPanel({ focusRamp = false }: { focusRamp?: boolean } = {}) {
  const account = useActiveAccount();
  const { publicKey: solanaPublicKey } = useWallet();
  const { address: cdpAddress } = useCdpAddress();
  // Session-backed Solana identity: after a reload the wallet ADAPTER is
  // disconnected (autoConnect off) but the signed session lives on — without
  // this, wallet users saw "Sign in to see it" although they're logged in.
  const { isAuthenticated: solanaSessionActive, walletAddress: solanaSessionAddress } = useSolanaAuth();
  const { toast } = useToast();

  const address =
    account?.address ??
    (solanaSessionActive ? solanaSessionAddress : null) ??
    solanaPublicKey?.toBase58() ??
    cdpAddress ??
    null;
  const { balance, ready } = useHoldings(address);

  const [earnings, setEarnings] = useState<Earnings | null>(earningsCache);
  const [rampBusy, setRampBusy] = useState<RampProvider | null>(null);
  const [mode, setMode] = useState<RampSide | null>(null);
  // Which ramp providers the server has keys for; unconfigured ones show
  // greyed with "Coming soon" and light up the moment their keys exist.
  const [providers, setProviders] = useState<{ coinbase: boolean; moonpay: boolean }>({ coinbase: true, moonpay: false });
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/onramp/session");
        if (!res.ok) return;
        const d = (await res.json()) as { providers?: { coinbase: boolean; moonpay: boolean } };
        if (!dead && d.providers) setProviders(d.providers);
      } catch { /* keep defaults */ }
    })();
    return () => { dead = true; };
  }, []);

  // ESC steps back one level (chooser → nothing) before the settings panel's
  // own ESC handling gets a chance to close the whole page.
  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMode(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode]);

  // Balance chip in the sidebar → scroll to "Move money" and pulse a
  // heartbeat around the whole section so the eye lands on it.
  const rampRef = useRef<HTMLDivElement | null>(null);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (!focusRamp) return;
    const t = setTimeout(() => {
      rampRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      setPulse(true);
    }, 180); // let the panel mount/paint first
    const off = setTimeout(() => setPulse(false), 4200);
    return () => { clearTimeout(t); clearTimeout(off); };
  }, [focusRamp]);

  useEffect(() => {
    // Session-based analytics endpoint — derived live from prompt_purchases
    // (the legacy /api/users/[id]/earnings read tables that don't exist).
    let cancelled = false;
    (async () => {
      try {
        // summary=1 → totals only; the server skips the heavy per-prompt
        // joins the Analytics panel needs.
        const res = await fetch("/api/analytics/me?summary=1", { headers: sessionAuthHeaders() });
        if (!res.ok) return;
        const data = (await res.json()) as {
          summary: { totalCents: number; salesCount: number; month: { cents: number } };
        };
        if (!cancelled) {
          const next: Earnings = {
            earnings: { total: data.summary.totalCents, thisMonth: data.summary.month.cents },
            sales: { total: data.summary.salesCount },
          };
          earningsCache = next;
          setEarnings(next);
        }
      } catch {
        /* earnings are additive info — the panel still works without them */
      }
    })();
    return () => { cancelled = true; };
  }, [address]);

  // On/offramp: the server builds a provider session (Coinbase token mint or
  // signed MoonPay URL) bound to the user's own wallet; we open the hosted
  // flow in a new tab. KYC is the provider's job; funds land in the wallet.
  const PROVIDER_KEY = "enki-ramp-provider";
  const lastProvider = (): RampProvider => {
    try { const v = localStorage.getItem(PROVIDER_KEY); if (v === "moonpay" || v === "coinbase") return v; } catch { /* noop */ }
    return "coinbase";
  };
  const launchRamp = async (side: RampSide, provider: RampProvider) => {
    setRampBusy(provider);
    try { localStorage.setItem(PROVIDER_KEY, provider); } catch { /* noop */ }
    try {
      const res = await fetch("/api/onramp/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ side, address, provider }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error || "Could not start the payment flow");
      window.open(data.url, "_blank", "noopener");
      setMode(null);
    } catch (e) {
      toast({
        title: side === "buy" ? "Couldn't open Add money" : "Couldn't open Pay out",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setRampBusy(null);
    }
  };
  const pickMode = (side: RampSide) => {
    if (!address) {
      toast({ title: "Sign in first", description: "Log in so we know which wallet the money belongs to.", variant: "destructive" });
      return;
    }
    setMode((v) => (v === side ? null : side));
  };

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast({ title: "Address copied" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const last = lastProvider();
  const payoutSub = !address
    ? "Sign in first"
    : ready && balance > 0
      ? `$${balance.toFixed(2)} available`
      : "Cash out your funds to your bank, card or PayPal";

  return (
    <>
      {/* ── 01 · Your money ── */}
      <SettingsSection num="01" title="Your money">
        <div className="set-holdings-hero">
          <div className="set-holdings-label">Balance</div>
          <div className="set-holdings-amount">
            {!address ? <span>Sign in to see it.</span> : ready ? <>${balance.toFixed(2)}</> : <span>Loading…</span>}
          </div>
          <div className="set-item-sub" style={{ marginTop: 8 }}>
            {!address
              ? "Your balance shows up here."
              : ready && balance <= 0
                ? "Add money to start generating."
                : "Yours to spend or withdraw, any time."}
          </div>
        </div>
        {/* Wallet, explained for a 10th grader — and why it exists at all. */}
        <div className="set-wallet-note">
          <div className="set-holdings-label" style={{ marginBottom: 6 }}>What&apos;s a wallet?</div>
          Your money lives in a <b>wallet</b> — a small digital pocket on the internet that only
          you hold the key to. We can&apos;t open it, and that&apos;s the whole point: because we never
          hold your money, everything you add stays yours and you can take it out any time.
        </div>
        {earnings && earnings.earnings.total > 0 && (
          <div className="set-earn-grid">
            <div className="set-earn-cell">
              <div className="set-earn-num">{usd(earnings.earnings.total)}</div>
              <div className="set-earn-label">Earned in total</div>
            </div>
            <div className="set-earn-cell">
              <div className="set-earn-num">{usd(earnings.earnings.thisMonth)}</div>
              <div className="set-earn-label">Earned this month</div>
            </div>
            <div className="set-earn-cell">
              <div className="set-earn-num">{earnings.sales.total}</div>
              <div className="set-earn-label">Sales</div>
            </div>
          </div>
        )}
      </SettingsSection>

      {/* ── 02 · Move money ── */}
      <div ref={rampRef} className={pulse ? "set-heartbeat" : undefined}>
      <SettingsSection num="02" title="Move money">
        <div className="set-money-body">
          {!mode ? (
            <div className="set-sq-grid">
              <button
                className="set-mode-tile"
                onClick={() => pickMode("buy")}
                disabled={rampBusy !== null}
                style={!address ? { opacity: 0.55 } : undefined}
              >
                <span className="set-mode-ic"><ArrowDownToLine size={20} /></span>
                <span className="set-mode-title">Add money</span>
                <span className="set-mode-sub">Card, Apple Pay or PayPal</span>
              </button>
              <button
                className="set-mode-tile"
                onClick={() => pickMode("sell")}
                disabled={rampBusy !== null}
                style={!address ? { opacity: 0.55 } : undefined}
              >
                <span className="set-mode-ic"><ArrowUpFromLine size={20} /></span>
                <span className="set-mode-title">Pay out</span>
                <span className="set-mode-sub">{payoutSub}</span>
              </button>
            </div>
          ) : (
            <div className="set-prov-wrap">
              <div className="set-prov-head">
                <button className="set-back-btn" onClick={() => setMode(null)} aria-label="Back">
                  <ArrowLeft size={15} />
                </button>
                <span className="set-holdings-label" style={{ marginBottom: 0 }}>
                  Pick a provider to {mode === "buy" ? "top up" : "pay out"}
                </span>
              </div>
              <div className="set-sq-grid">
                {RAMPS.map((r) => {
                  const on = providers[r.id];
                  const isLast = on && r.id === last;
                  return (
                    <button
                      key={r.id}
                      className={"set-prov-card" + (isLast ? " set-prov-card--last" : "") + (on ? "" : " set-prov-card--off")}
                      onClick={() => { if (on) void launchRamp(mode, r.id); }}
                      disabled={!on || rampBusy !== null}
                      title={on ? undefined : "Coming soon"}
                    >
                      <span className="set-prov-logo" style={{ background: r.logoBg }}>
                        {rampBusy === r.id ? <Loader2 size={18} className="set-spin" /> : r.logo}
                      </span>
                      <span className="set-prov-name">{r.name}</span>
                      {isLast && <span className="set-prov-chip">Last used</span>}
                      {!on && <span className="set-prov-chip set-prov-chip--off">Coming soon</span>}
                      <span className="set-prov-sub">{mode === "buy" ? r.buySub : r.sellSub}</span>
                    </button>
                  );
                })}
              </div>
              <div className="set-footnote">
                {mode === "buy"
                  ? "Adding money needs a one-time identity check with the payment partner — that's the law for money services, and it's their job, not ours. Deposits arrive as digital dollars (USDC) in your own wallet: always worth $1, always yours to withdraw. We never hold your money."
                  : "Your whole balance goes to your bank, card or PayPal. We never hold your money."}
              </div>
            </div>
          )}
        </div>
      </SettingsSection>
      </div>

      {/* ── 03 · Deposit crypto (wallet users only) ── */}
      <BillingPanel />

      {/* ── 04 · Networks (collapsed by default) ── */}
      <details className="set-section set-networks">
        <summary>
          <span><span className="set-section-num" style={{ marginRight: 12 }}>04</span>Networks</span>
          <ChevronDown size={16} className="set-chevron" />
        </summary>
        <div className="set-section-desc" style={{ paddingBottom: 12 }}>
          The blockchains your account runs on. You don&apos;t need to touch this — it&apos;s here so you can see how things work.
        </div>
        <div className="set-list-item">
          <div className="set-item-icon">◎</div>
          <div className="set-item-content">
            <div className="set-item-title">Solana <span className="set-badge-good">Active</span></div>
            <div className="set-item-sub">Payments and trophies run here.</div>
            {address && (
              <div className="set-item-sub" style={{ fontFamily: "monospace" }}>
                {address.slice(0, 6)}…{address.slice(-6)}
              </div>
            )}
          </div>
          {address && (
            <button className="set-btn set-btn-outline" onClick={copyAddress}><Copy size={12} /> Copy</button>
          )}
        </div>
        <div className="set-list-item" style={{ opacity: 0.6 }}>
          <div className="set-item-icon">◆</div>
          <div className="set-item-content">
            <div className="set-item-title">Base <span className="set-badge-warn">Coming soon</span></div>
            <div className="set-item-sub">Cheaper card top-ups later on.</div>
          </div>
        </div>
        <div className="set-list-item" style={{ opacity: 0.6 }}>
          <div className="set-item-icon">◇</div>
          <div className="set-item-content">
            <div className="set-item-title">Ethereum <span className="set-badge-warn">Coming soon</span></div>
            <div className="set-item-sub">For collectors who live there.</div>
          </div>
        </div>
        {/* LUKSO is the achievements chain (Solana pays, LUKSO remembers)
            — listed as coming so the plan is visible (Kev, 2026-08-24). */}
        <div className="set-list-item" style={{ opacity: 0.6 }}>
          <div className="set-item-icon">◈</div>
          <div className="set-item-content">
            <div className="set-item-title">LUKSO <span className="set-badge-warn">Coming soon</span></div>
            <div className="set-item-sub">Achievements and creator identity will live here.</div>
          </div>
        </div>
      </details>
    </>
  );
}
