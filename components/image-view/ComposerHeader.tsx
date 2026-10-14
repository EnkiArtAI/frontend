"use client";

import { useState } from "react";
import { Bookmark, ChevronLeft, Download, Flag, Heart, Share } from "lucide-react";
import BookmarkPicker from "@/components/enki/BookmarkPicker";
import { downloadImage } from "@/components/kit/share";
import { ReportButton } from "@/components/ReportButton";
import { openCreator } from "@/lib/openCreator";
import { countLabel } from "@/lib/ui/image-view/discussion";
import { copyText, type ImageViewModel } from "./useImageViewModel";

/** The prompt's link: the native share sheet where there is one, else copied. */
async function sharePrompt(title: string, promptId: string) {
  const url = `${location.origin}/generator/${encodeURIComponent(promptId)}`;
  if (typeof navigator.share === "function") {
    try {
      return await navigator.share({ title, url });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
    }
  }
  copyText(url, "Link copied");
}

/**
 * The top of the left column: Back, the tier, the title, who made it and its
 * rating, then Bookmark, Like, Download, Share and Report. The blank composer
 * ("New image") keeps Back and Download.
 */
export default function ComposerHeader({ model: m, onBack }: { model: ImageViewModel; onBack: () => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const talk = m.discussion.data;
  const main = m.main;
  const url = main?.original;

  return (
    <header className="iv-head">
      <div className="iv-head-top">
        <button type="button" className="iv-round kit-hit" aria-label="Back" title="Back" onClick={onBack}>
          <ChevronLeft size={14} strokeWidth={2.4} aria-hidden />
        </button>
        {/* Only Premium wears a kicker; an open prompt says so under its text (Kev, 2026-10-13). */}
        {!m.blank && m.premium && <span className="iv-tier" data-premium>Premium prompt</span>}
      </div>
      <h1 className="kit-title iv-title" data-blank={m.blank || undefined}>{m.title}</h1>
      {(m.artist || talk?.avgRating != null) && (
        <div className="iv-by">
          {m.artist?.handle ? (
            <span>by <button type="button" className="iv-by-link" onClick={() => openCreator(m.artist?.handle as string)}>@{m.artist.handle}</button></span>
          ) : m.artist?.name && <span>by {m.artist.name}</span>}
          {talk?.avgRating != null && (
            <span className="iv-rating" title={`Average of ${countLabel(talk.reviews.length, talk.capped)} ratings`}>
              <span aria-hidden>★</span>{talk.avgRating.toFixed(1)} <span>({countLabel(talk.reviews.length, talk.capped)})</span>
            </span>
          )}
        </div>
      )}
      <div className="iv-acts">
        {m.promptId && !m.guest && (
          /* The mark alone, filled once saved: no word beside it (Kev, 2026-10-13). */
          <button type="button" className="iv-act iv-act--icon kit-hit" data-on={m.saved ? "saved" : undefined} aria-expanded={!!anchor}
            aria-label={m.saved ? "Saved · file it elsewhere" : "Bookmark"} title={m.saved ? "Saved · file it elsewhere" : "Bookmark"}
            onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}>
            <Bookmark size={13} strokeWidth={2} fill={m.saved ? "currentColor" : "none"} aria-hidden />
          </button>
        )}
        {m.promptId && (
          <button type="button" className="iv-act kit-hit" data-on={m.likes?.mine ? "liked" : undefined} aria-pressed={!!m.likes?.mine}
            aria-label={m.likes?.mine ? "Unlike" : "Like"} disabled={!m.likes} onClick={m.toggleLike}>
            <Heart size={13} strokeWidth={2} fill={m.likes?.mine ? "currentColor" : "none"} aria-hidden />{m.likes?.count ?? ""}
          </button>
        )}
        {url && main && (
          <button type="button" className="iv-act iv-act--icon kit-hit" aria-label="Download" title="Download"
            onClick={() => void downloadImage(url, m.title, m.finished.indexOf(main) + 1)}>
            <Download size={13} strokeWidth={2.2} aria-hidden />
          </button>
        )}
        {m.promptId && (
          <button type="button" className="iv-act iv-act--icon kit-hit" aria-label="Share" title="Share"
            onClick={() => void sharePrompt(m.title, m.promptId as string)}>
            <Share size={13} strokeWidth={2.2} aria-hidden />
          </button>
        )}
        {m.promptId && (
          <ReportButton targetType="prompt" targetId={m.promptId} className="iv-act iv-act--icon kit-hit">
            <Flag size={13} strokeWidth={2.2} aria-hidden />
          </ReportButton>
        )}
      </div>
      {anchor && m.promptId && (
        <BookmarkPicker promptId={m.promptId} imageUrl={url} anchor={anchor} memberships={m.memberships} onClose={() => setAnchor(null)} onChange={m.bookmarked} />
      )}
    </header>
  );
}
