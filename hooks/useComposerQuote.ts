"use client";

/**
 * The server's price for exactly what Generate would send (plan §1.2). The
 * key holds every field, so a changed setting asks again and the previous
 * price is never shown next to the new settings: until the answer, `pending`.
 */
import { useQuery } from "@tanstack/react-query";
import { fetchGenerationQuote, PromptUnavailable, type QuoteRequest } from "@/lib/generation-checkout";
import type { CatalogueEntry } from "@/hooks/useModelLimits";

export interface ComposerQuoteRequest {
  /** A marketplace prompt (its artist share is priced); absent for the buyer's own text. */
  promptId?: string;
  entry: CatalogueEntry | undefined;
  resolution: "1K" | "2K" | "4K";
  quality?: "low" | "medium" | "high";
  boost: boolean;
  referenceImageCount: number;
}

export function useComposerQuote(req: ComposerQuoteRequest | null) {
  const entry = req?.entry;
  // The free host is never quoted: the route refuses it, and it charges nothing.
  // Quality and boost are masked as runGeneration masks them, so the price is the one the intent charges.
  const body: QuoteRequest | null =
    req && entry && !entry.free
      ? {
          promptId: req.promptId,
          modelId: entry.id,
          resolution: req.resolution,
          quality: entry.supportsQuality ? req.quality : undefined,
          boost: req.boost && entry.boostAvailable === true,
          referenceImageCount: req.referenceImageCount,
        }
      : null;

  const { data, isPending, error } = useQuery({
    queryKey: ["composer-quote", body],
    queryFn: () => fetchGenerationQuote(body as QuoteRequest),
    enabled: body !== null,
    staleTime: 60_000,
    // Quotes expire server-side after 5 minutes; refresh a little sooner.
    refetchInterval: 4 * 60 * 1000,
    // Only PromptUnavailable throws, and asking again will not bring the prompt back.
    retry: false,
  });

  return {
    quote: data ?? null,
    pending: body !== null && isPending,
    unavailable: error instanceof PromptUnavailable,
    /** The server gave no price (the chip shows none; never a guess). */
    failed: data === null,
  };
}
