"use client";

import { useState, type MouseEvent, type Ref } from "react";
import { useQueryClient } from "@tanstack/react-query";
import BookmarkPicker from "@/components/enki/BookmarkPicker";
import { preloadImageUI } from "@/components/enki/EnkiDetailPanel";
import { Icon } from "@/components/enki-shell/icons";
import { notify } from "@/components/kit/notify";
import { priceChipLabel, type FeedCard as Card } from "@/lib/ui/feed/card";
import type { Membership } from "@/lib/ui/feed/bookmark-index";

/**
 * One card of the wall: the picture, its price chip top left ("Open" for an
 * open prompt), and a bookmark top right only once the prompt IS bookmarked
 * (Kev, 2026-10-13: no title, no artist on a card; the bookmark "nur aktiv
 * … wenn ich es gebookmarked hab"). A tap opens the image view, which is
 * where a prompt is bookmarked in the first place.
 */
export default function FeedCard({ ref, card, onOpen, canBookmark, saved }: {
  ref?: Ref<HTMLElement>;
  card: Card;
  onOpen: (card: Card) => void;
  /** Signed in: guests and team visitors get no bookmark. */
  canBookmark: boolean;
  /** Where the prompt is bookmarked (the session's bookmark index). */
  saved: readonly Membership[] | undefined;
}) {
  const queryClient = useQueryClient();
  const [img, setImg] = useState<"loading" | "loaded" | "error">("loading");
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const title = card.title || "Untitled prompt";
  const price = priceChipLabel(card.priceCents);
  const by = card.creator;
  const artist = by ? (by.handle ? `@${by.handle}` : by.name) : null;
  const isSaved = Boolean(saved?.length);

  // Warm what a click needs while the pointer is still on its way.
  const warm = () => {
    preloadImageUI();
    queryClient.prefetchQuery({ queryKey: [`/api/prompts/${card.id}`] }).catch(() => {});
  };
  const toggleMark = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const at = e.currentTarget.getBoundingClientRect();
    setAnchor(anchor ? null : at);
  };

  return (
    <article ref={ref} data-pid={card.id} className={"feed-card" + (img === "loaded" ? " is-loaded" : "")}
      onPointerEnter={warm} onFocus={warm}>
      {card.images[0] && img !== "error" && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img className="feed-card-img" src={card.images[0]} alt={title} loading="lazy" decoding="async" draggable={false}
          onLoad={() => setImg("loaded")} onError={() => setImg("error")} />
      )}
      <button type="button" className="feed-card-hit" onClick={() => onOpen(card)}
        aria-label={`${title}${by ? ` by ${artist}` : ""}${price ? `, ${price}` : ""}`} />
      {price && <span className={"feed-card-price" + (card.priceCents === 0 ? " is-free" : "")}>{price}</span>}
      {canBookmark && (isSaved || anchor) && (
        <button type="button" className="feed-card-mark kit-hit" onClick={toggleMark}
          aria-pressed={isSaved} aria-label={`Bookmark ${title}`} title="Saved · click to change">
          <Icon name="bookmark" size={15} stroke={2} fill="currentColor" />
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
