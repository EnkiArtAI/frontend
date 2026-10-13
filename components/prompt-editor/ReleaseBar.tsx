"use client";

import { boxRatio } from "@/lib/ui/kit/ratio";

export interface ReleasePhoto {
  key: string;
  src: string;
  ratio: string | null;
}

/**
 * The end of Verify: the starred set beside the button that releases it
 * (handoff §4: "3/4" sits right at Release). Release stays pressable while it
 * cannot go yet, and says why when pressed. After a release it reads
 * "✓ Released"; the next release updates the same prompt (R13).
 */
export default function ReleaseBar({ need, photos, ratio, listingOnly, released, blocked, busy, anyReady, mode, price, onRelease, onMore }: {
  need: number;
  /** The starred renders in star order, or the live images of a listing-only update. */
  photos: ReleasePhoto[];
  /** The current ratio, for empty slots. */
  ratio: string;
  listingOnly: boolean;
  released: boolean;
  blocked: boolean;
  busy: boolean;
  anyReady: boolean;
  mode: "free" | "premium";
  price: number;
  onRelease: () => void;
  onMore: () => void;
}) {
  const tone = released ? "released" : blocked ? "short" : "ok";
  const label = released ? "Released" : listingOnly ? "Live images" : `${photos.length}/${need} starred`;
  const sub = listingOnly ? "Live images kept" : !anyReady ? "Generate first" : photos.length < need ? "All from one variation" : "Ready to release";
  const action = busy ? "Releasing…"
    : released ? "✓ Released"
    : listingOnly ? "✦ Update listing"
    : mode === "premium" ? `✦ Release · $${price.toFixed(2)}`
    : "✦ Release free";
  return (
    <div className="pe-release">
      <div className="pe-pick" data-tone={tone}>
        <div className="pe-slots" aria-hidden>
          {Array.from({ length: need }, (_, i) => {
            const p = photos[i];
            return (
              <span key={p?.key ?? `empty-${i}`} className="pe-slot" data-filled={p ? "" : undefined}
                style={{ aspectRatio: boxRatio(p?.ratio ?? ratio) }}>
                {p ? <img src={p.src} alt="" /> : "★"}
              </span>
            );
          })}
        </div>
        <div className="pe-pick-text">
          <span className="pe-pick-label">{label}</span>
          <span className="pe-pick-sub">{sub}</span>
        </div>
        <button type="button" className="pe-more pe-tabs-only" onClick={onMore}>✦ More</button>
      </div>
      <button type="button" className="pe-release-btn kit-hit" onClick={onRelease} disabled={busy || released}
        aria-disabled={(blocked && !released) || undefined} data-released={released || undefined}>
        {busy && <span className="pe-spin" aria-hidden />}
        {action}
      </button>
    </div>
  );
}
