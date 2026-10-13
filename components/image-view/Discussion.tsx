"use client";

import { useRef, useState, type FormEvent } from "react";
import { MessageSquare } from "lucide-react";
import Segmented from "@/components/kit/Segmented";
import { openCreator } from "@/lib/openCreator";
import { openLogin } from "@/lib/openLogin";
import { countLabel, type CommentRow } from "@/lib/ui/image-view/discussion";
import { formatAgo, initials } from "@/lib/ui/kit/format";
import type { ImageViewModel } from "./useImageViewModel";

const stars = (n: number) => "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(n);

/**
 * Comments | Reviews below the stage, read as the centre scrolls (no toggle
 * panel, handoff §2). Both are rows of one table (plan §5 #20). A comment is
 * text from anyone signed in; a review shows one of the viewer's own images
 * made with this prompt, with stars and words if they like (Kev, 2026-10-13:
 * "reviews = comments but with a generated image").
 */
export default function Discussion({ model: m }: { model: ImageViewModel }) {
  const [tab, setTab] = useState<"comments" | "reviews">("comments");
  const [draft, setDraft] = useState("");
  const [rating, setRating] = useState(0);
  const [imageId, setImageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const { data, error, retry } = m.discussion;
  const rows = data ? (tab === "comments" ? data.comments : data.reviews) : [];
  const count = (n: number) => (data ? ` · ${countLabel(n, data.capped)}` : "");
  // The picked image, or the newest of the viewer's own once there is one.
  const picked = m.reviewable.find((x) => x.record?.id === imageId) ?? m.reviewable[0];
  const ready = tab === "comments" ? !!draft.trim() : !!picked;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (busy || !ready) return;
    setBusy(true);
    const ok = await m.post(tab === "comments"
      ? { body }
      : { imageId: picked!.record!.id, ...(rating ? { rating } : {}), ...(body ? { body } : {}) });
    setBusy(false);
    if (!ok) return;
    setDraft("");
    setRating(0);
  };

  return (
    <section className="iv-talk" aria-label="Comments and reviews">
      <div className="iv-talk-tabs">
        <Segmented ariaLabel="Comments or reviews" role="tablist" value={tab}
          onChange={(t) => {
            setTab(t);
            requestAnimationFrame(() => panel.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
          }}
          options={[
            { key: "comments", label: <><MessageSquare size={13} strokeWidth={2} aria-hidden />Comments{count(data?.comments.length ?? 0)}</> },
            {
              key: "reviews",
              label: <>★ Reviews{count(data?.reviews.length ?? 0)}{!m.guest && !m.reviewable.length && <span className="iv-dim"> with your image</span>}</>,
            },
          ]} />
        {rows.length > 0 && <span className="iv-hint">scroll down to read</span>}
      </div>

      <div ref={panel} className="iv-talk-panel">
        <div className="iv-talk-list" role="tabpanel">
          {error && (
            <p className="iv-talk-note">{error} <button type="button" className="iv-link" onClick={retry}>Try again</button></p>
          )}
          {!data && !error && <p className="iv-talk-note">Loading…</p>}
          {data && !rows.length && <p className="iv-talk-note">{tab === "comments" ? "No comments yet" : "No reviews yet"}</p>}
          {rows.map((r) => <Row key={r.id} row={r} now={m.now} review={tab === "reviews"} />)}
          {data?.capped && <p className="iv-talk-note">Showing the newest 100</p>}
        </div>

        {m.guest ? (
          <div className="iv-compose">
            <button type="button" className="iv-send" onClick={openLogin}>Sign in to comment</button>
          </div>
        ) : tab === "reviews" && !m.reviewable.length ? (
          <p className="iv-gate">A review shows one of your own images made with this prompt — generate one first</p>
        ) : (
          <form className="iv-compose" data-review={tab === "reviews" || undefined} onSubmit={send}>
            {tab === "reviews" && (
              <div className="iv-review-pick" role="radiogroup" aria-label="The image your review shows">
                {m.reviewable.map((x) => (
                  <button key={x.key} type="button" role="radio" aria-checked={x === picked} className="iv-review-img kit-hit"
                    title="Show this image with your review" onClick={() => setImageId(x.record!.id)}>
                    <img src={x.thumb} alt="" draggable={false} />
                  </button>
                ))}
              </div>
            )}
            <div className="iv-compose-row">
              {tab === "reviews" && (
                <span className="iv-rate" role="radiogroup" aria-label="Your rating">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n === 1 ? "" : "s"}`}
                      className="iv-star" data-on={n <= rating || undefined} onClick={() => setRating(rating === n ? 0 : n)}>★</button>
                  ))}
                </span>
              )}
              <input className="iv-input" value={draft} maxLength={2000} disabled={busy} onChange={(e) => setDraft(e.target.value)}
                aria-label={tab === "comments" ? "Your comment" : "Your review"}
                placeholder={tab === "comments" ? "Add a comment" : "Say how it went (optional)"} />
              <button type="submit" className="iv-send" disabled={!ready || busy}>Send</button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

function Row({ row, now, review }: { row: CommentRow; now: number; review: boolean }) {
  const who = row.handle === "anonymous" ? <span className="iv-c-who">{row.handle}</span>
    : <button type="button" className="iv-c-who" onClick={() => openCreator(row.handle)}>{row.handle}</button>;
  return (
    <article className="iv-c">
      {review && row.imageUrl
        ? <img className="iv-c-img" src={row.imageUrl} alt="" draggable={false} />
        : !review && <span className="iv-av" aria-hidden>{initials(row.handle)}</span>}
      <div className="iv-c-main">
        <div className="iv-c-head">
          {review && typeof row.rating === "number" && <span className="iv-stars" aria-label={`${row.rating} of 5`}>{stars(row.rating)}</span>}
          {who}
          <span className="iv-c-when">{formatAgo(row.createdAt, now, "short")}</span>
        </div>
        {row.body && <p className="iv-c-body">{row.body}</p>}
      </div>
    </article>
  );
}
