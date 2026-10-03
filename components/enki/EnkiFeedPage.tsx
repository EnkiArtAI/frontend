"use client";

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import EnkiCard from "@/components/enki/EnkiCard";
import EnkiFilters from "@/components/enki/EnkiFilters";
import GenerateLauncher from "@/components/GenerateLauncher";
import EnkiDetailPanel from "@/components/enki/EnkiDetailPanel";
import type { EnkiPrompt } from "@/lib/enkiPromptAdapter";
import { mapMarketplacePromptToEnkiPrompt } from "@/lib/enkiPromptAdapter";
import { useModelCatalogue } from "@/hooks/useModelLimits";
import { toModelFamily } from "@/lib/generation/model-family";
import { useBetaAccess } from "@/components/BetaGate";
import { SHOW_ADULT_KEY, viewerHeaders } from "@/lib/session-headers";

function useLocalFavorites() {
  const [favs, setFavs] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem("enki:favorites") || "{}");
    } catch {
      return {};
    }
  });

  const toggleFav = (id: string) => {
    setFavs((current) => {
      const next = { ...current, [id]: !current[id] };
      if (typeof window !== "undefined") {
        localStorage.setItem("enki:favorites", JSON.stringify(next));
      }
      return next;
    });
  };

  return { favs, toggleFav };
}

export default function EnkiFeedPage() {
  const [tags, setTags] = useState<string[]>([]);
  /* Which generators feed the wall — ids from the model catalogue, grouped
     Image/Video for the filter chip (Kev, 2026-08-24). The models table has
     no media type yet, so every entry is Image; a Video group appears by
     itself the day a video model lands in the catalogue. */
  const [genFilter, setGenFilter] = useState<string[]>([]);
  const catalogue = useModelCatalogue();
  /* The tree's branches: Image and Video, each carrying the DB's models of
     that medium (models.media_type). A branch with no models does not
     render — the Video branch appears by itself the day the first video
     row (Seedance, Kling, …) lands in the table. */
  const generatorGroups = useMemo(() => {
    const branch = (label: string, media: "image" | "video") => {
      const entries = catalogue.filter((c) => c.mediaType === media).map((c) => ({ id: c.id, name: c.name }));
      return entries.length ? [{ label, entries }] : [];
    };
    return [...branch("Image", "image"), ...branch("Video", "video")];
  }, [catalogue]);
  const [open, setOpen] = useState<EnkiPrompt | null>(null);
  const { favs, toggleFav } = useLocalFavorites();
  /* 18+ pill (Kev, 2026-10-03): only a user who confirmed in Settings that
     they are 18 or older sees it, and it stays off until they turn it on.
     The server checks the confirmation again behind the header. */
  const { adultConfirmed } = useBetaAccess();
  const [adultPill, setAdultPill] = useState(false);
  useEffect(() => {
    try { setAdultPill(localStorage.getItem(SHOW_ADULT_KEY) === "1"); } catch { /* off */ }
  }, []);
  const flipAdult = (on: boolean) => {
    try { if (on) localStorage.setItem(SHOW_ADULT_KEY, "1"); else localStorage.removeItem(SHOW_ADULT_KEY); } catch { /* not kept */ }
    setAdultPill(on);
  };
  const showAdult = adultConfirmed && adultPill;

  // OPEN counter: opening a prompt fires a fire-and-forget beacon; the server
  // dedupes per viewer for 10 min and increments prompts.opens atomically.
  useEffect(() => {
    if (!open?.id) return;
    fetch(`/api/prompts/${encodeURIComponent(open.id)}/view`, { method: "POST" }).catch(() => {});
  }, [open?.id]);

  // VIEW counter (timeline impressions): one IntersectionObserver watches every
  // card; ids that became at least half visible are buffered and flushed as ONE
  // batched call every 3s. A session-level set makes sure each prompt is sent
  // at most once per visit (the server dedupes again on top).
  const impressionSeen = useRef<Set<string>>(new Set());
  const impressionBuffer = useRef<Set<string>>(new Set());
  const impressionObserver = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    impressionObserver.current = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const pid = (e.target as HTMLElement).dataset.pid;
          if (e.isIntersecting && pid && !impressionSeen.current.has(pid)) {
            impressionSeen.current.add(pid);
            impressionBuffer.current.add(pid);
          }
        }
      },
      { threshold: 0.5 },
    );
    const flush = setInterval(() => {
      if (impressionBuffer.current.size === 0) return;
      const ids = [...impressionBuffer.current];
      impressionBuffer.current.clear();
      fetch("/api/prompts/views-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }).catch(() => {});
    }, 3000);
    return () => { impressionObserver.current?.disconnect(); clearInterval(flush); };
  }, []);
  const observeCard = useCallback((el: HTMLDivElement | null) => {
    if (el) impressionObserver.current?.observe(el);
  }, []);

  type Page = { prompts: unknown[]; hasMore: boolean; nextCursor?: string };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    error,
    refetch,
  } = useInfiniteQuery<Page, Error, { pages: Page[]; pageParams: number[] }, string[], number>({
    queryKey: ["/api/marketplace/prompts", "home", genFilter.join(","), showAdult ? "18+" : "safe"],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({
        limit: "24",
        sortBy: "trending",
        cursor: String(pageParam),
      });
      /* Generator filter: send EVERY alias of the picked generators — the
         prompts table's ai_model carries names AND slugs mixed ("Flux
         (free)", "nano-banana-pro"), so one id would miss half the rows. */
      for (const id of genFilter) {
        const entry = catalogue.find((c) => c.id === id);
        if (!entry) continue;
        for (const alias of new Set([entry.id, entry.name, toModelFamily(entry.name)])) {
          if (alias) params.append("models", String(alias));
        }
      }
      const res = await fetch(`/api/marketplace/prompts?${params.toString()}`, { headers: viewerHeaders(), credentials: "include" });
      if (!res.ok) {
        // The server's own sentence (e.g. "database unreachable") beats a
        // generic one — and a failure must never look like an empty feed.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Couldn't load prompts (HTTP ${res.status}).`);
      }
      const json = await res.json();
      return json as Page;
    },
    getNextPageParam: (lastPage) => {
      const next = lastPage.nextCursor ? parseInt(lastPage.nextCursor, 10) : undefined;
      return Number.isNaN(next) ? undefined : next;
    },
    initialPageParam: 0,
    staleTime: 60_000,
  });

  /* IntersectionObserver for infinite scroll */
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelCallback = useCallback(
    (node: HTMLDivElement | null) => {
      if (observerRef.current) observerRef.current.disconnect();
      observerRef.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      });
      if (node) observerRef.current.observe(node);
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage]
  );

  const allPrompts = useMemo<EnkiPrompt[]>(() => {
    const pages = data?.pages ?? [];
    const flat = pages.flatMap((page, pageIndex) =>
      Array.isArray(page.prompts)
        ? page.prompts.map((item: unknown, idx: number) => mapMarketplacePromptToEnkiPrompt(item, pageIndex * 24 + idx))
        : []
    );
    return flat;
  }, [data]);

  const searchParams = useSearchParams();
  const query = searchParams.get("q")?.toLowerCase() || "";

  const visible = useMemo<EnkiPrompt[]>(() => {
    let filtered = allPrompts;
    if (tags.length) {
      filtered = filtered.filter((prompt) => tags.every((tag) => prompt.tags.includes(tag)));
    }
    if (query) {
      filtered = filtered.filter((prompt) =>
        prompt.title.toLowerCase().includes(query) ||
        prompt.description.toLowerCase().includes(query)
      );
    }
    return filtered;
  }, [allPrompts, tags, query]);

  const toggleTag = (tag: string) => {
    setTags((current) => (current.includes(tag) ? [] : [tag]));
  };

  const showEmpty = !isPending && visible.length === 0 && !isFetchingNextPage;

  return (
    <>
      <main className="enki">
        {visible.length > 0 ? (
          <section className="enki-masonry">
            {visible.map((prompt) => (
              <div key={prompt.id} data-pid={prompt.id} ref={observeCard} style={{ breakInside: "avoid" }}>
                <EnkiCard
                  prompt={prompt}
                  onOpen={setOpen}
                />
              </div>
            ))}
            {/* Sentinel for infinite scroll */}
            <div ref={sentinelCallback} style={{ height: 1, breakInside: "avoid" }} />
            {/* Skeleton loaders for next page */}
            {isFetchingNextPage && (
              <>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={`sk-${i}`} className="enki-skeleton" />
                ))}
              </>
            )}
          </section>
        ) : isPending ? (
          <section className="enki-masonry">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={`sk-init-${i}`} className="enki-skeleton" />
            ))}
          </section>
        ) : error ? (
          <section className="enki-empty-state">
            <div className="enki-account-card">
              <div className="serif" style={{ fontSize: 28, marginBottom: 8 }}>Couldn't load the feed.</div>
              <p style={{ margin: 0, color: "var(--enki-ink-2)" }}>{error.message}</p>
              <button type="button" className="ek-btn" style={{ marginTop: 16, minHeight: 40 }} onClick={() => void refetch()}>Try again</button>
            </div>
          </section>
        ) : showEmpty ? (
          <section className="enki-empty-state">
            <div className="enki-account-card">
              <div className="serif" style={{ fontSize: 28, marginBottom: 8 }}>No prompts here yet.</div>
              <p style={{ margin: 0, color: "var(--enki-ink-2)" }}>
                Adjust your filters to widen the results.
              </p>
            </div>
          </section>
        ) : null}

        {/* The floating "Generate" button, and only that. It used to be handed
            the clicked card as a seed, which opened the quick-create modal
            over the feed — Kev, 2026-08-13: "wenn ich ein image anclicke SOLL
            NICHT quick create oder sowas aufgehen". */}
        <GenerateLauncher />
      </main>

      {/* Clicking a card opens the canonical image view — the same one the
          /generator route and the profile grid open, so a buyer meets one
          layout everywhere: variables and generate on the left, the image in
          the middle, the session's other images beneath it, comments and
          reviews at the top, history on the right.

          EnkiDetailPanel is the frame that already knows to start where the
          shell's menu ends, so this inherits that rather than restating it. */}
      {open && (
        <EnkiDetailPanel
          prompt={open}
          onClose={() => setOpen(null)}
          faved={Boolean(favs[open.id])}
          toggleFav={toggleFav}
        />
      )}

      <EnkiFilters active={tags} toggle={toggleTag}
        generators={generatorGroups} generatorFilter={genFilter} onGeneratorFilter={setGenFilter}
        showAdult={showAdult} onShowAdult={adultConfirmed ? flipAdult : undefined} />
    </>
  );
}
