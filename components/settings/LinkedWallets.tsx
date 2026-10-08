"use client";

/**
 * Settings → Profile → Linked wallets: the Solana wallets this account linked
 * for their NFTs (the NFT picker), with unlink. A linked wallet is only read;
 * /api/wallet/linked says why it never signs in, pays or gets paid.
 */
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import SettingsSection from "@/components/settings/SettingsSection";
import LinkWalletButtons from "@/components/settings/LinkWalletButtons";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { markWalletsChanged } from "@/components/settings/link-wallet";

const ROUTE = "/api/wallet/linked";

export default function LinkedWallets({ num }: { num: string }) {
  const { toast } = useToast();
  // null = not loaded yet; a failed load is said, never shown as "none".
  const [wallets, setWallets] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped after a link: the server's list is the truth.
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(ROUTE, { headers: sessionAuthHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { wallets?: string[] }) => { if (live) { setWallets(d.wallets ?? []); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [round]);

  const unlink = async (address: string) => {
    const res = await fetch(ROUTE, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ address }),
    }).catch(() => null);
    // 404: no such link on this account (a double click, another tab): it is unlinked either way.
    if (res?.ok || res?.status === 404) {
      markWalletsChanged();
      setWallets((w) => (w ?? []).filter((a) => a !== address));
    }
    else toast({ title: "Couldn't unlink", variant: "destructive" });
  };

  return (
    <SettingsSection num={num} title="Linked wallets">
      <div className="set-section-desc" style={{ paddingBottom: 14, fontSize: 12.5 }}>
        Link a Phantom or Solflare wallet to use its NFTs as reference images. A linked wallet is only read: it does not sign in, pay or get paid.
      </div>
      {failed ? (
        <div className="set-section-desc">Your linked wallets could not be loaded. Open this tab again in a moment.</div>
      ) : wallets === null ? (
        <div className="set-section-desc">Loading…</div>
      ) : (
        wallets.map((a) => (
          <div key={a} className="set-list-item">
            <div className="set-item-content"><div className="set-item-title" title={a}>{a.slice(0, 4)}…{a.slice(-4)}</div></div>
            <button className="set-btn set-btn-outline" onClick={() => void unlink(a)}>Unlink</button>
          </div>
        ))
      )}
      <div style={{ paddingTop: 10 }}>
        <LinkWalletButtons buttonClass="set-btn set-btn-outline" onLinked={() => setRound((r) => r + 1)} />
      </div>
    </SettingsSection>
  );
}
