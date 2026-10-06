"use client";

/**
 * Server quotes for display, one per option, in one request.
 *
 * Kev, 2026-10-02: "ich brauche safe überall den server-quote". The editors
 * priced their labels in the browser from the catalogue price, without the
 * fee and without quality, so the number shown was not the number charged.
 * Every price a generate surface shows now comes from here, the same
 * arithmetic the intent charges. Null for an option means no price: the
 * label shows nothing rather than a guess.
 */
import { useQuery } from "@tanstack/react-query";
import { fetchGenerationQuotes, microToUsd, type GenerationQuote, type QuoteRequest } from "@/lib/generation-checkout";

export function useServerQuotes(reqs: QuoteRequest[]): Array<GenerationQuote | null> {
  const key = JSON.stringify(reqs);
  const { data } = useQuery({
    queryKey: ["generation-quotes", key],
    queryFn: () => fetchGenerationQuotes(reqs),
    enabled: reqs.length > 0,
    staleTime: 60_000,
    // Quotes expire server-side after 5 minutes; refresh a little sooner.
    refetchInterval: 4 * 60 * 1000,
  });
  return data && data.length === reqs.length ? data : reqs.map(() => null);
}

/** "$0.147", or "$0.588" for four images; null when there is no quote. */
export function quoteLabel(q: GenerationQuote | null | undefined, count = 1): string | null {
  return q ? `$${microToUsd(q.totalMicro * count)}` : null;
}
