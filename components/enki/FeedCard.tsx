"use client";

import { useRef, useState, type MouseEvent, type Ref } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import BookmarkPicker from "@/components/enki/BookmarkPicker";
import { preloadImageUI } from "@/components/enki/EnkiDetailPanel";
import { Icon } from "@/components/enki-shell/icons";
import { notify } from "@/components/kit/notify";
import { openCreator } from "@/lib/openCreator";
import { HOVER } from "@/lib/ui/kit/breakpoints";
import { priceChipLabel, type FeedCard as Card } from "@/lib/ui/feed/card";
import { ratingSummary } from "@/lib/ui/feed/rating";
import type { Membership } from "@/lib/ui/feed/bookmark-index";

/** A pointer resting this long asks for the rating; a sweep asks nothing. */
const DWELL_MS = 150;

/**
 * One card of the wall. The price chip always shows; title, artist, rating
 * and bookmark show on hover or keyboard focus, and on touch after a first
 * tap (`revealed`; the second tap opens). A card without an image stays
 * revealed so its title reads on the paper.
 */
export default function FeedCard({ ref, card, revealed, onReveal, onOpen, canBookmark, saved }: {
  ref?: Ref<HTMLElement>;
  card: Card;
  revealed: boolean;
  onReveal: (id: string) => void;
  onOpen: (card: Card) => void;
  /** Signed in: guests and team visitors get no bookmark button. */
  canBookmark: boolean;
  /** Where the prompt is bookmarked (the session's bookmark index). */
  saved: readonly Membership[] | undefined;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [img, setImg] = useState<"loading" | "loaded" | "error">("loading");
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [wantRating, setWantRating] = useState(false);
  const dwell = useRef<number | undefined>(undefined);
  // Shares its key with the Image View's comments, so opening reuses it.
  const { data } = useQuery({ queryKey: [`/api/prompts/${card.id}/comments`], enabled: wantRating, staleTime: 60_000 });
  const rating = ratingSummary(data);

  const title = card.title || "Untitled prompt";
  const price = priceChipLabel(card.priceCents);
  const by = card.creator;
  const artist = by ? (by.handle ? `@${by.handle}` : by.name) : null;
  const bare = !card.images.length || img === "error";
  const isSaved = Boolean(saved?.length);

  // Warm what a click needs while the pointer is still on its way.
  const warm = () => {
    preloadImageUI();
    queryClient.prefetchQuery({ queryKey: [`/api/prompts/${card.id}`] }).catch(() => {});
  };
  const press = (e: MouseEvent) => {
    // Touch: the first tap shows what hover shows. A key press (detail 0) opens.
    if (!revealed && !bare && e.detail > 0 && !window.matchMedia(HOVER).matches) {
      onReveal(card.id);
      setWantRating(true);
      return;
    }
    onOpen(card);
  };
  const toggleMark = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const at = e.currentTarget.getBoundingClientRect();
    setAnchor(anchor ? null : at);
  };

  return (
    <article
      ref={ref}
      data-pid={card.id}
      className={"feed-card" + (revealed || bare ? " is-revealed" : "") + (isSaved || anchor ? " is-marked" : "")
        + (img === "loaded" ? " is-loaded" : "")}
      onPointerEnter={() => { warm(); dwell.current = window.setTimeout(() => setWantRating(true), DWELL_MS); }}
      onPointerLeave={() => window.clearTimeout(dwell.current)}
      onFocus={() => { warm(); setWantRating(true); }}
    >
      {card.images[0] && img !== "error" && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img className="feed-card-img" src={card.images[0]} alt={title} loading="lazy" decoding="async" draggable={false}
          onLoad={() => setImg("loaded")} onError={() => setImg("error")} />
      )}
      <button type="button" className="feed-card-hit" onClick={press}
        aria-label={`${title}${by ? ` by ${artist}` : ""}${price ? `, ${price}` : ""}`} />
      <div className="feed-card-foot">
        <span className="feed-card-title">{title}</span>
        <span className="feed-card-row">
          {by && (
            <button type="button" className="feed-card-artist kit-hit"
              onClick={(e) => { e.stopPropagation(); openCreator(by.handle || by.id, router); }}>
              {artist}
            </button>
          )}
          {rating && (
            <span className="feed-card-rating" title={rating.title}>
              <span className="feed-card-star" aria-hidden>★</span>{rating.avg}<span className="feed-card-n">({rating.count})</span>
            </span>
          )}
          {price && <span className={"feed-card-price" + (card.priceCents === 0 ? " is-free" : "")}>{price}</span>}
        </span>
      </div>
      {canBookmark && (
        <button type="button" className="feed-card-mark kit-hit" onClick={toggleMark}
          aria-pressed={isSaved} aria-label={`Bookmark ${title}`} title={isSaved ? "Saved · click to change" : "Save to bookmarks"}>
          <Icon name="bookmark" size={15} stroke={2} fill={isSaved ? "currentColor" : "none"} />
        </button>
      )}
      {anchor && (
        <BookmarkPicker promptId={card.id} imageUrl={card.images[0]} anchor={anchor} memberships={saved}
          onChange={(kind, name) => notify(kind === "added" ? `Saved to ${name}` : `Removed from ${name}`)}
          onClose={() => setAnchor(null)} />
      )}
    </article>
  );
}
