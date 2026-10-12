"use client";

import { useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { parseRatio } from "@/lib/ui/kit/ratio";
import { metaOf, useAgain, type ImageViewModel, type Shot } from "./useImageViewModel";

/**
 * The image on the stage, as large as the area allows and never squashed:
 * its box is min(100cqh, 100cqw / ratio) of a size container (handoff §2).
 * A finished image opens the viewer; a render shows its spinner, a failed
 * one what happened and, when nothing can have been charged, Retry at its
 * own price. The X leaves the page.
 */
export default function MainImage({ model: m, onOpen, onClose }: {
  model: ImageViewModel;
  onOpen: (shot: Shot) => void;
  onClose: () => void;
}) {
  // A picture's own ratio, once it has loaded; the asked one until then.
  const [natural, setNatural] = useState<Record<string, number>>({});
  const s = m.main;
  const job = s?.job;
  const src = s?.src;
  const ratio = (src && natural[src]) || parseRatio(s ? s.ratio : m.ratio) || 1;
  const meta = s && metaOf(s, m.now);
  const retry = useAgain(m, job?.status === "failed" ? job : undefined);

  return (
    <div className="iv-stage">
      <div className="iv-box" data-state={job && job.status !== "ready" ? job.status : undefined} style={{ "--ar": ratio } as CSSProperties}>
        {!s ? (
          <p className="iv-empty">Your image shows up here</p>
        ) : job?.status === "rendering" ? (
          <span className="iv-ring" role="status" aria-label="Rendering" />
        ) : job?.status === "failed" ? (
          <div className="iv-fail">
            <span className="iv-bang" aria-hidden>!</span>
            <span>{job.error?.message}</span>
            {retry && (
              <button type="button" className="iv-retry kit-hit" disabled={!retry.ready} onClick={retry.press}>
                ⟳ {retry.label}{retry.price && ` · ${retry.price}`}
              </button>
            )}
          </div>
        ) : src && (
          <button type="button" className="iv-open" aria-label="Open fullscreen" onClick={() => onOpen(s)}>
            <img src={src} alt="" draggable={false}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                if (w && h) setNatural((n) => (n[src] === w / h ? n : { ...n, [src]: w / h }));
                m.seen(s);
              }} />
          </button>
        )}
        {meta && <span className="iv-meta">{meta}</span>}
      </div>
      <button type="button" className="iv-x kit-hit" aria-label="Close" title="Close" onClick={onClose}>
        <X size={14} strokeWidth={2.2} aria-hidden />
      </button>
    </div>
  );
}
