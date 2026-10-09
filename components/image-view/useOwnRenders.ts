"use client";

/**
 * The viewer's own renders, read 100 at a time (GET /api/generations has no
 * prompt filter, plan §5 #15): the History rail's rows, the recorded id
 * behind a fresh render (its Public switch, plan §5 #23), and what opens the
 * comment composers. A render is recorded after its answer arrives, so while
 * a finished job is missing from the rows the read asks again every 3 s, for
 * 60 s at most.
 */
import { useEffect, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { viewerHeaders } from "@/lib/session-headers";
import {
  generationsUrl, historyForPrompt, nextOffset, readGenerations, unrecorded,
  type GenerationRow, type GenerationsPage,
} from "@/lib/ui/image-view/history";
import type { Job } from "@/lib/ui/kit/render-queue";

/** One page, with the viewer's headers: without the session the owner's private rows are not theirs. */
export async function readOwnPage(userKey: string, offset: number): Promise<GenerationsPage> {
  const res = await fetch(generationsUrl(userKey, offset), { headers: viewerHeaders() });
  if (!res.ok) throw new Error(`Your renders could not load (HTTP ${res.status}).`);
  return readGenerations(await res.json());
}

/** Asks again every 3 s and gives up after 60 s; returns the stop. */
export function pollWhile(refetch: () => void): () => void {
  const tick = setInterval(refetch, 3000);
  const stop = setTimeout(() => clearInterval(tick), 60_000);
  return () => {
    clearInterval(tick);
    clearTimeout(stop);
  };
}

/** The finished jobs the rows do not hold yet, as one key: each new one starts its own 60 s. */
export const waitingFor = (jobs: Job<unknown>[], rows: GenerationRow[]) =>
  jobs.filter((j) => j.status === "ready" && unrecorded([j], rows)).map((j) => j.id).join(" ");

export function useOwnRenders({ userKey, promptId, jobs }: {
  userKey: string | null;
  /** Null in the blank composer: its renders belong to no prompt, so nothing is read. */
  promptId: string | null;
  jobs: Job<unknown>[];
}) {
  const enabled = !!userKey && !!promptId;
  const q = useInfiniteQuery({
    queryKey: ["user-generations", userKey],
    queryFn: ({ pageParam }) => readOwnPage(userKey as string, pageParam),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextOffset(pages),
    enabled,
    staleTime: 30_000,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.generations) ?? [], [q.data]);

  const waiting = enabled ? waitingFor(jobs, rows) : "";
  const { refetch } = q;
  useEffect(() => (waiting ? pollWhile(() => void refetch()) : undefined), [waiting, refetch]);

  return {
    /** Every row read, every prompt's: what a render's recorded id is looked up in. */
    rows,
    /** This prompt's renders, none a queued job still shows. */
    history: historyForPrompt(rows, promptId, jobs),
    loading: enabled && q.isPending,
    failed: q.isError,
    retry: () => void refetch(),
    more: q.hasNextPage,
    loadingOlder: q.isFetchingNextPage,
    loadOlder: () => void q.fetchNextPage(),
  };
}
