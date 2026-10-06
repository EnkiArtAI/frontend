"use client";

import FilterBar from "@/components/FilterBar";
import ArtworkGrid, { ArtworkItem } from "@/components/ArtworkGrid";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import PromptDetailModal from "@/components/PromptDetailModal";
import { useQuery, useQueries } from "@tanstack/react-query";

// Dynamically import components that use browser-only hooks to prevent SSR errors
const ShowroomUploadZone = dynamic(
  () => import("@/components/ShowroomUploadZone"),
  { ssr: false }
);

export default function Showcase() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const typeParam = searchParams.get("type"); // "images" | "videos" | null
  const PAGE_SIZE = 12;
  const [cursor, setCursor] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [selectedPromptData, setSelectedPromptData] = useState<any>(null);

  // Prevent SSR issues by only rendering after mount
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const {
    data: promptsData,
    isLoading,
    fetchStatus,
  } = useQuery({
    queryKey: ["/api/prompts", cursor],
    queryFn: async () => {
      const url = new URL("/api/prompts", window.location.origin);
      if (cursor) url.searchParams.set("cursor", cursor);
      url.searchParams.set("limit", String(PAGE_SIZE));
      const res = await fetch(url.toString(), { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch: ${res.statusText}`);
      return res.json();
    },
    enabled: isMounted, // Only run query after mounting
  });

  const [allPrompts, setAllPrompts] = useState<any[]>([]);

  useEffect(() => {
    if (promptsData?.items) {
      const items = promptsData.items.map((item: any) => ({
        ...item,
        id: item._id?.toString() || item.id,
        creatorId: item.creator?.toString?.() || item.creator || item.creatorId,
      }));

      if (cursor === null) {
        setAllPrompts(items);
      } else {
        setAllPrompts((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          return [
            ...prev,
            ...items.filter((item: any) => !existingIds.has(item.id)),
          ];
        });
      }
    }
  }, [promptsData, cursor]);

  const creatorIds = useMemo(
    () => [...new Set(allPrompts.map((p: any) => p.creatorId).filter(Boolean))],
    [allPrompts]
  );

  const creatorQueries = useQueries({
    queries: creatorIds.map((id) => ({
      queryKey: ["/api/users", id],
      queryFn: async () => {
        const res = await fetch(`/api/users/${id}`, { credentials: "include" });
        return res.ok ? (await res.json()).user : null;
      },
      staleTime: 5 * 60 * 1000,
      enabled: isMounted && creatorIds.length > 0, // Only run after mounting
    })),
  });

  const creatorsMap = useMemo(() => {
    const map = new Map();
    creatorQueries.forEach((q) => {
      if (q.data) {
        map.set(q.data._id?.toString() || q.data.id, {
          displayName: q.data.profile?.displayName,
          username: q.data.profile?.username,
        });
      }
    });
    return map;
  }, [creatorQueries]);

  const isVideo = (url: string) => /\.(mp4|webm|mov|avi)$/i.test(url ?? "");

  const visiblePrompts = useMemo<ArtworkItem[]>(() => {
    return allPrompts
      .filter((p: any) => p.id)
      .map((p: any): ArtworkItem => {
        const creator = creatorsMap.get(p.creatorId);
        const apiThumb =
          p.thumbnail ||
          p.imageUrl ||
          p.showcaseImages?.find((i: any) => i?.isPrimary === true)?.thumbnail ||
          p.showcaseImages?.[0]?.thumbnail ||
          p.showcaseImages?.[0]?.url ||
          "";
        const isFree = Boolean(
          p.isFree ?? (p.type === "showcase" || p.type === "free" || p.type === "free-prompt") ?? p.isFreeShowcase
        );

        return {
          id: p.id,
          title: p.title ?? "",
          artistId: p.creatorId,
          artistName:
            creator?.displayName || creator?.username || "Unknown Artist",
          price: typeof p.price === "number" ? p.price : (p.pricing?.pricePerGeneration ?? 0),
          isFree,
          isFreeShowcase: Boolean(p.isFreeShowcase ?? false),
          rating: typeof p.rating === "number" ? p.rating : (p.stats?.reviews?.averageRating ?? 0),
          downloads: typeof p.downloads === "number" ? p.downloads : (p.stats?.totalGenerations ?? 0),
          thumbnail: apiThumb,
          imageUrl: apiThumb,
          category: p.category ?? "",
          tags: p.tags,
          publicPromptText: p.publicPromptText,
          variables: Array.isArray(p.variables) ? p.variables : undefined,
        };
      })
      .filter((p) => {
        if (typeParam === "videos") return isVideo(p.thumbnail ?? "");
        if (typeParam === "images") return !isVideo(p.thumbnail ?? "");
        return true;
      });
  }, [allPrompts, creatorsMap, typeParam]);

  const hasMore = promptsData?.nextCursor !== null;
  const isLoadingMore = fetchStatus === "fetching" && cursor !== null;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || isLoadingMore) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && promptsData?.nextCursor) {
          setCursor(promptsData.nextCursor);
        }
      },
      { rootMargin: "800px" }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, promptsData?.nextCursor]);

  // Show loading state during SSR and initial mount
  if (!isMounted || (isLoading && allPrompts.length === 0)) {
    return (
      <div className="min-h-screen bg-background pt-16">
        <FilterBar onFilterChange={(f) => console.log("Filters:", f)} />
        <main className="w-full px-2 py-2 flex items-center justify-center">
          <p className="text-foreground text-lg">Loading prompts...</p>
        </main>
      </div>
    );
  }

  if (visiblePrompts.length === 0) {
    return (
      <div className="min-h-screen bg-background pt-16">
        <FilterBar onFilterChange={(f) => console.log("Filters:", f)} />
        <main className="w-full px-2 py-8 flex flex-col items-center justify-center">
          <p className="text-foreground text-lg mb-4">
            No prompts available yet
          </p>
          <p className="text-foreground/60 text-sm">
            Be the first to create and release a prompt!
          </p>
        </main>
        <ShowroomUploadZone />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pt-16">
      <FilterBar onFilterChange={(f) => console.log("Filters:", f)} />
      <main className="w-full px-2 py-2">
        <ArtworkGrid
          items={visiblePrompts}
          variant="prompt"
          useMasonryLayout
          onCardClick={(id) => {
            const prompt = visiblePrompts.find((p) => p.id === id);
            if (prompt) {
              setSelectedPromptData({
                ...prompt,
                artist: prompt.artistName,
                imageUrl: prompt.thumbnail,
              });
            }
          }}
        />
        <div ref={sentinelRef} className="h-10" />
        <div className="w-full py-4 flex items-center justify-center text-sm text-muted-foreground">
          {isLoadingMore
            ? "Loading more..."
            : hasMore
              ? "Scroll to load more..."
              : "You're all caught up."}
        </div>
      </main>
      <ShowroomUploadZone />
      <PromptDetailModal
        isOpen={!!selectedPromptData}
        onClose={() => setSelectedPromptData(null)}
        prompt={selectedPromptData}
      />
    </div>
  );
}
