/**
 * Every price the Prompt Editor shows, asked in ONE useServerQuotes batch
 * (create-desktop §3.15): the Generate chip, each tier and quality of the
 * test generator, and each image generator in the menus. Each is asked for
 * exactly what Generate would charge (renderSettings, the reference count
 * included: without it the shown price was below the charge). A free model
 * is never asked (the route refuses it, and it charges nothing), and no
 * promptId is sent: a creator's own test pays no artist share.
 */
import type { GenerationQuote, QuoteRequest } from "@/lib/generation-checkout";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import { tiersUpTo } from "@/lib/generation/resolution";
import { renderSettings, type Quality, type RenderPicks } from "./generate-checks";

/** The most items the quote route takes in one batch. */
export const MAX_QUOTES = 24;

const QUALITIES: Quality[] = ["low", "medium", "high"];

/** The quote for one model at these picks; null where nothing is asked (no model, the free host). */
export function quoteRequest(entry: CatalogueEntry | undefined, picks: RenderPicks, refCount: number): QuoteRequest | null {
  if (!entry || entry.free) return null;
  const { resolution, quality, boost } = renderSettings(entry, picks);
  return { modelId: entry.id, resolution, quality, boost, referenceImageCount: refCount };
}

/**
 * The batch, deduplicated, the chip first so the cap never drops it. A model
 * without quality asks its three qualities as one: each masks to the chip.
 */
export function quoteBatch(catalogue: CatalogueEntry[], test: CatalogueEntry | undefined, picks: RenderPicks, refCount: number): QuoteRequest[] {
  const asks = [
    quoteRequest(test, picks, refCount),
    ...(test ? tiersUpTo(test.maxResolution).map((resolution) => quoteRequest(test, { ...picks, resolution }, refCount)) : []),
    ...QUALITIES.map((quality) => quoteRequest(test, { ...picks, quality }, refCount)),
    ...catalogue.filter((m) => m.mediaType === "image").map((m) => quoteRequest(m, picks, refCount)),
  ];
  const unique = new Map(asks.flatMap((q) => (q ? [[JSON.stringify(q), q] as const] : [])));
  return [...unique.values()].slice(0, MAX_QUOTES);
}

/** The batch's answer for `req` (useServerQuotes answers in the batch's order); null when it was not asked or has no price. */
export function quoteIn(batch: QuoteRequest[], quotes: Array<GenerationQuote | null>, req: QuoteRequest | null): GenerationQuote | null {
  const key = JSON.stringify(req);
  return quotes[batch.findIndex((q) => JSON.stringify(q) === key)] ?? null;
}
