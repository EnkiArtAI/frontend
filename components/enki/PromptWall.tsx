"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBetaAccess } from "@/components/BetaGate";
import { useBookmarkIndex } from "@/hooks/useBookmarkIndex";
import { failureSentence } from "@/lib/search/client";
import { sessionHeadersWith } from "@/lib/session-headers";
import { seedFromFeedCard, toFeedCard, type FeedCard as Card } from "@/lib/ui/feed/card";
import EnkiDetailPanel from "./EnkiDetailPanel";
import FeedCard from "./FeedCard";
import MasonryGrid from "./MasonryGrid";
import "./feed.css";

/** The most ids one marketplace read takes (its `limit` cap). */
const CHUNK = 50;

/**
 * The cards for `ids`, in that order, as the feed shows them: one
 * /api/marketplace/prompts?ids= read per 50. A prompt the marketplace no
 * longer serves (unlisted, hidden creator, 18+ with the pill off) is simply
 * not among them.
 */
export function useCards(ids: readonly string[], showAdult: boolean) {
  return useQuery<Card[], Error>({
    queryKey: ["prompt-cards", ids.join(","), showAdult ? "18+" : "safe"],
    queryFn: async () => {
      const byId = new Map<string, Card>();
      for (let i = 0; i < ids.length; i += CHUNK) {
        const q = new URLSearchParams({ limit: String(CHUNK) });
        for (const id of ids.slice(i, i + CHUNK)) q.append("ids", id);
        const res = await fetch(`/api/marketplace/prompts?${q}`, { headers: sessionHeadersWith(showAdult), credentials: "include" });
        if (!res.ok) throw new Error(await failureSentence(res, "Couldn't load prompts"));
        const page = (await res.json()) as { prompts?: unknown[] };
        for (const raw of page.prompts ?? []) {
          const card = toFeedCard(raw);
          if (card) byId.set(card.id, card);
        }
      }
      return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    },
    enabled: ids.length > 0,
    staleTime: 60_000,
  });
}

/**
 * A wall of prompts shown exactly like Home (Kev, 2026-10-13: "the same view
 * like on home"): the feed's cards in its masonry, a tap opens the image view
 * beside the menu. `ids` is the order; the caller pages (`more`, `onMore`)
 * and says what an empty wall shows (`note`).
 */
export default function PromptWall({ ids, loading = false, note, more = false, onMore }: {
  ids: readonly string[];
  /** The caller is still reading ids: skeletons stand where cards will land. */
  loading?: boolean;
  note?: ReactNode;
  more?: boolean;
  onMore?: () => void;
}) {
  const { access, role, adultConfirmed, adultPill } = useBetaAccess();
  const authed = access === "ok" && role !== "team";
  const cards = useCards(ids, adultConfirmed && adultPill);
  const items = cards.data ?? [];
  const index = useBookmarkIndex(authed && cards.data !== undefined);
  const [open, setOpen] = useState<Card | null>(null);

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || !onMore) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) onMore();
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, onMore]);

  const pending = loading || (ids.length > 0 && cards.isPending);
  return (
    <div className="feed-wall">
      {cards.error && (
        <p className="feed-wall-note">{cards.error.message} <button type="button" className="ek-btn" onClick={() => void cards.refetch()}>Try again</button></p>
      )}
      {(items.length > 0 || pending) && (
        <MasonryGrid items={items} skeletons={pending ? 6 : 0} renderItem={(card) => (
          <FeedCard card={card} onOpen={setOpen} canBookmark={authed} saved={index?.get(card.id)} />
        )} />
      )}
      {!pending && !cards.error && items.length === 0 && note}
      {more && <div ref={sentinel} className="feed-sentinel" />}
      {open && <EnkiDetailPanel seed={seedFromFeedCard(open)} onClose={() => setOpen(null)} />}
    </div>
  );
}
