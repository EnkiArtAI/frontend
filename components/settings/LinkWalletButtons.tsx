"use client";

/**
 * One button per installed Solana wallet that can sign a message; a click
 * links it to the signed-in account (link-wallet.ts). Settings → Profile and
 * the NFT picker (when it finds no wallet) use it, for email accounts only: a
 * wallet account's own wallet would lose its remembered connection when the
 * adapter disconnects after linking. No settings.css here: the picker loads it too.
 */
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState, type Adapter, type MessageSignerWalletAdapter } from "@solana/wallet-adapter-base";
import { Loader2 } from "lucide-react";
import { linkWallet } from "@/components/settings/link-wallet";

/** A wallet that can sign the link text; others cannot prove they hold the address. */
const canLink = (a: Adapter): a is MessageSignerWalletAdapter =>
  (a.readyState === WalletReadyState.Installed || a.readyState === WalletReadyState.Loadable)
  && "signMessage" in a && typeof a.signMessage === "function";

export default function LinkWalletButtons({ buttonClass, onLinked }: { buttonClass: string; onLinked: () => void }) {
  const { wallets } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const linkable = wallets.map((w) => w.adapter).filter(canLink);

  if (!linkable.length) return <span>Install Phantom or Solflare to link a wallet.</span>;
  const link = async (adapter: MessageSignerWalletAdapter) => {
    setBusy(adapter.name);
    setErr(null);
    try {
      await linkWallet(adapter);
      onLinked();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The wallet could not be linked.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      {linkable.map((a) => (
        <button key={a.name} type="button" className={buttonClass} disabled={!!busy} onClick={() => void link(a)}>
          {busy === a.name && <Loader2 size={13} className="animate-spin" />} Link {a.name}
        </button>
      ))}
      {err && <span role="alert" style={{ width: "100%", color: "var(--enki-danger)", fontSize: 12 }}>{err}</span>}
    </div>
  );
}
