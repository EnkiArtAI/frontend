"use client";

/**
 * NFT picker for quick create (Kev, 2026-08-22): a popup listing every NFT
 * in the signed-in account's wallets; clicking marks/unmarks, "Use N"
 * hands the marked images back as reference images.
 */
import { useEffect, useState } from "react";
import { X, Check, Loader2, ImageOff } from "lucide-react";
import { sessionAuthHeaders } from "@/lib/session-headers";
import type { NftPick } from "@/hooks/useReferenceReads";
// Shared popup chrome (spinner, CTA button) + its own styles live here.
import "@/components/enki/bookmarks.css";

type Nft = { id: string; name: string; image: string; thumb: string; collection: string | null };

export default function NftPickerModal({ max, onPick, onClose }: {
  /** How many the caller can still take (free reference slots). */
  max: number;
  /** The marked NFTs, each read through our own route (useReferenceReads). */
  onPick: (picks: NftPick[]) => void;
  onClose: () => void;
}) {
  const [nfts, setNfts] = useState<Nft[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [marked, setMarked] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/wallet/nfts", { headers: { ...sessionAuthHeaders() } })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "NFTs unavailable");
        setNfts(d.nfts);
      })
      .catch((e: Error) => { setNfts([]); setProblem(e.message); });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const toggle = (id: string) => setMarked((m) => {
    const next = new Set(m);
    if (next.has(id)) next.delete(id);
    else if (next.size < max) next.add(id);
    return next;
  });

  const use = () => {
    const picks = (nfts ?? []).filter((n) => marked.has(n.id)).map(({ image, thumb }) => ({ image, thumb }));
    if (picks.length) onPick(picks);
    onClose();
  };

  return (
    <div className="enki-nftp-scrim" onClick={onClose}>
      <div className="enki-nftp" onClick={(e) => e.stopPropagation()}>
        <div className="enki-nftp-head">
          <span>Your NFTs</span>
          <button type="button" className="enki-nftp-x" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        {nfts === null && <div className="enki-nftp-note"><Loader2 size={14} className="enki-bmp-spin" /> Loading your wallets…</div>}
        {problem && <div className="enki-nftp-note"><ImageOff size={14} /> {problem}</div>}
        {nfts?.length === 0 && !problem && <div className="enki-nftp-note">No NFTs found in your connected wallets.</div>}
        {max <= 0 && <div className="enki-nftp-note">All image slots are full — remove one first.</div>}
        {!!nfts?.length && (
          <div className="enki-nftp-grid">
            {nfts.map((n) => (
              <button key={n.id} type="button"
                className={"enki-nftp-item" + (marked.has(n.id) ? " on" : "")}
                title={n.name} onClick={() => toggle(n.id)}>
                <img src={n.thumb} alt={n.name} draggable={false} loading="lazy" />
                {marked.has(n.id) && <span className="enki-nftp-check"><Check size={11} /></span>}
              </button>
            ))}
          </div>
        )}
        <div className="enki-nftp-foot">
          <span className="enki-nftp-count mono">{marked.size} / {max} selected</span>
          <button type="button" className="enki-bmp-go" disabled={!marked.size} onClick={use}>Use {marked.size || ""}</button>
        </div>
      </div>
    </div>
  );
}
