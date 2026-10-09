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
 * panel, handoff §2). Both are rows of one table (plan §5 #20). The composers
 * open once the viewer has an image of this prompt; a comment is text, a
 * review a rating with optional words (plan §5 #18, #19).
 */
export default function Discussion({ model: m }: { model: ImageViewModel }) {
  const [tab, setTab] = useState<"comments" | "reviews">("comments");
  const [draft, setDraft] = useState("");
  const [rating, setRating] = useState(0);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const { data, error, retry } = m.discussion;
  const rows = data ? (tab === "comments" ? data.comments : data.reviews) : [];
  const count = (n: number) => (data ? ` · ${countLabel(n, data.capped)}` : "");

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (busy || (tab === "comments" ? !body : !rating)) return;
    setBusy(true);
    const ok = await m.post(tab === "comments" ? { body } : { rating, ...(body ? { body } : {}) });
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
              label: <>★ Reviews{count(data?.reviews.length ?? 0)}{m.premium && !m.canPost && <span className="iv-dim"> requires purchase</span>}</>,
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
        ) : tab === "reviews" && !m.canPost ? (
          <p className="iv-gate">
            {m.premium ? "Reviews are open to people who bought a render of this prompt" : "Rate this prompt after you generated with it"}
          </p>
        ) : (
          <form className="iv-compose" onSubmit={send}>
            {tab === "reviews" && (
              <span className="iv-rate" role="radiogroup" aria-label="Your rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n === 1 ? "" : "s"}`}
                    className="iv-star" data-on={n <= rating || undefined} onClick={() => setRating(n)}>★</button>
                ))}
              </span>
            )}
            <input className="iv-input" value={draft} maxLength={2000} disabled={!m.canPost || busy} onChange={(e) => setDraft(e.target.value)}
              aria-label={tab === "comments" ? "Your comment" : "Your review"}
              placeholder={!m.canPost ? "Generate an image with this prompt first to comment" : tab === "comments" ? "Add a comment" : "Say why (optional)"} />
            <button type="submit" className="iv-send" disabled={!m.canPost || busy || (tab === "comments" ? !draft.trim() : !rating)}>Send</button>
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
      {!review && <span className="iv-av" aria-hidden>{initials(row.handle)}</span>}
      <div className="iv-c-main">
        <div className="iv-c-head">
          {review && <span className="iv-stars" aria-label={`${row.rating} of 5`}>{stars(row.rating ?? 0)}</span>}
          {who}
          <span className="iv-c-when">{formatAgo(row.createdAt, now, "short")}</span>
        </div>
        {row.body && <p className="iv-c-body">{row.body}</p>}
      </div>
    </article>
  );
}
