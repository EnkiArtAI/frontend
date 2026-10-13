"use client";

import { useState, type MouseEvent, type Ref } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import BookmarkPicker from "@/components/enki/BookmarkPicker";
import { preloadImageUI } from "@/components/enki/EnkiDetailPanel";
import { Icon } from "@/components/enki-shell/icons";
import { notify } from "@/components/kit/notify";
import { openCreator } from "@/lib/openCreator";
import { priceChipLabel, type FeedCard as Card } from "@/lib/ui/feed/card";
import type { Membership } from "@/lib/ui/feed/bookmark-index";

/**
 * One card of the wall: the picture and its price chip top left ("Open" for
 * an open prompt). Everything else waits for a hover or the keyboard focus
 * (Kev, 2026-10-13): then the title, the artist (a link) and the bookmark
 * rise in. A bookmark that is set stays visible top right. A tap opens the
 * image view.
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
  const router = useRouter();
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
    <article ref={ref} data-pid={card.id}
      className={"feed-card" + (img === "loaded" ? " is-loaded" : "") + (isSaved || anchor ? " is-marked" : "")}
      onPointerEnter={warm} onFocus={warm}>
      {card.images[0] && img !== "error" && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img className="feed-card-img" src={card.images[0]} alt={title} loading="lazy" decoding="async" draggable={false}
          onLoad={() => setImg("loaded")} onError={() => setImg("error")} />
      )}
      <button type="button" className="feed-card-hit" onClick={() => onOpen(card)}
        aria-label={`${title}${by ? ` by ${artist}` : ""}${price ? `, ${price}` : ""}`} />
      {price && <span className={"feed-card-price" + (card.priceCents === 0 ? " is-free" : "")}>{price}</span>}
      <div className="feed-card-foot">
        <span className="feed-card-title">{title}</span>
        {by && (
          <button type="button" className="feed-card-artist kit-hit"
            onClick={(e) => { e.stopPropagation(); openCreator(by.handle || by.id, router); }}>
            {artist}
          </button>
        )}
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
