"use client";

import { useState } from "react";
import { Bookmark, Download, Link2, RotateCw, Share } from "lucide-react";
import BookmarkPicker from "@/components/enki/BookmarkPicker";
import BottomSheet from "@/components/kit/BottomSheet";
import ValueList from "@/components/kit/ValueList";
import { downloadImage, shareImage, shareWithLink } from "@/components/kit/share";
import { ReportButton } from "@/components/ReportButton";
import { copyText, metaOf, useAgain, type ImageViewModel, type Shot } from "./useImageViewModel";

/**
 * The fullscreen viewer's panel (handoff §2): the values a render of this tab
 * was made with, each with Copy, its meta, then Regenerate with that render's
 * own price (disabled until there is one), Download, Bookmark, and Share
 * image beside Share + prompt. The viewer's own recorded renders carry the
 * Public switch, someone else's public image carries Report. The blank
 * composer keeps Regenerate, Download and Share image.
 */
export default function ViewerPanel({ model: m, shot, n, onAgain }: {
  model: ImageViewModel;
  shot: Shot;
  /** Its place among the page's images, for the file name. */
  n: number;
  /** Regenerate or Retry was pressed: the viewer closes first, so no wallet prompt or low-balance question opens under it. */
  onAgain: () => void;
}) {
  const [sheet, setSheet] = useState(false);
  const { job, record } = shot;
  const again = useAgain(m, job);
  const url = shot.original ?? shot.src;
  const meta = metaOf(shot, m.now);
  const link = m.promptId && `${location.origin}/generator/${encodeURIComponent(m.promptId)}`;

  return (
    <div className="iv-vpanel">
      {job?.setup.rows.length ? (
        <ValueList rows={job.setup.rows} tone="stage" onCopy={(r) => copyText(r.value, `Copied ${r.name}`)} />
      ) : (
        <p className="iv-vnote">{job ? "This render used no variables" : "No values are stored for this image"}</p>
      )}
      {meta && <p className="iv-vmeta">{meta}</p>}

      {record && (
        <label className="iv-public">
          <input type="checkbox" role="switch" checked={record.visibility === "public"}
            onChange={(e) => void m.setPublic(record, e.target.checked)} />
          <span className="iv-switch" aria-hidden />
          <span className="iv-public-text">
            Public
            <span>
              {record.visibility !== "public" ? "Only you see it"
                : record.prompt_id === m.promptId ? "Shown under this prompt and on your profile" : "Shown on your profile"}
            </span>
          </span>
        </label>
      )}
      {shot.publicId && !m.guest && (
        <ReportButton targetType="generation" targetId={shot.publicId} className="iv-vreport">Report this image</ReportButton>
      )}

      <div className="iv-vacts">
        {again && (
          <button type="button" className="iv-vact kit-hit" data-primary disabled={!again.ready}
            onClick={() => {
              onAgain();
              again.press();
            }}>
            <RotateCw size={18} strokeWidth={2} aria-hidden />{again.label}
            {again.price && <span className="iv-vprice">{again.price}</span>}
          </button>
        )}
        {url && (
          <button type="button" className="iv-vact kit-hit" onClick={() => void downloadImage(url, m.title, n)}>
            <Download size={18} strokeWidth={2} aria-hidden />Download
          </button>
        )}
        {m.promptId && !m.guest && (
          <button type="button" className="iv-vact kit-hit" onClick={() => setSheet(true)}>
            <Bookmark size={18} strokeWidth={2} fill={m.saved ? "currentColor" : "none"} aria-hidden />{m.saved ? "Saved" : "Bookmark"}
          </button>
        )}
        {url && (
          <button type="button" className="iv-vact kit-hit" title="Anyone with the link can open this image" onClick={() => void shareImage(url)}>
            <Share size={18} strokeWidth={2} aria-hidden />Share image
          </button>
        )}
        {url && link && (
          <button type="button" className="iv-vact kit-hit" title="The image and a link to this prompt" onClick={() => void shareWithLink(url, link, m.title)}>
            <Link2 size={18} strokeWidth={2} aria-hidden />Share + prompt
          </button>
        )}
      </div>

      {/* A sheet, not the floating picker: that one sits at the popover layer, under the viewer. */}
      {m.promptId && (
        <BottomSheet open={sheet} title="Save to" onClose={() => setSheet(false)}>
          {sheet && (
            <div className="iv-sheet-bmp">
              <BookmarkPicker promptId={m.promptId} imageUrl={url} onClose={() => setSheet(false)} onChange={m.bookmarked} />
            </div>
          )}
        </BottomSheet>
      )}
    </div>
  );
}
