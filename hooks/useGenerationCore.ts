"use client";

/**
 * THE one source for generation-core settings (Kev, 2026-08-22: "every
 * generation UI derives the generation core settings the same way with the
 * einstellungen being set up only globally").
 *
 * Layering:
 *   models table (DB)  →  /api/models (withCapabilities: maxResolution,
 *   allowed_ratios, supportsQuality, tierScale, boostAvailable — resolved by
 *   the SAME code the generation enforces)  →  useModelCatalogue  →  THIS
 *   hook  →  every generate surface.
 *
 * A surface may render its own controls, but every OPTION LIST, PRICE and
 * VISIBILITY decision comes from here. Nothing model-specific may be
 * hardcoded in a component — that is how three surfaces once carried three
 * different ratio lists and a 2K/4K list survived after the models stopped
 * matching it.
 *
 * Per-surface variance is expressed through the arguments, not through
 * copies: `freeRoute: true` says "this surface renders on the free route
 * regardless of the selected model" (quick create today, the buyer
 * generator's no-charge path), which clamps tiers and ratios to the free
 * model's ceiling instead of the selection's.
 */
import { useMemo } from "react";
import {
  useModelCatalogue, resolveCatalogueEntry, boostAt,
  FALLBACK_RATIOS, type CatalogueEntry,
} from "@/hooks/useModelLimits";
import { tiersUpTo, type ResolutionTier } from "@/lib/generation/resolution";

export type TierOption = { tier: ResolutionTier };

export type GenerationCore = {
  /** Every active model, DB-driven — for model pickers. */
  catalogue: CatalogueEntry[];
  /** The resolved selection (by id, family slug, plain slug or exact name). */
  entry: CatalogueEntry | undefined;
  /** True while /api/models has not answered — render "loading", never guesses. */
  loading: boolean;
  /** Aspect ratios the EFFECTIVE model accepts (DB allowed_ratios). */
  ratios: string[];
  /** Resolution tiers up to the effective model's ceiling, with the price
      one image costs at that tier (null when nothing is charged). */
  tiers: TierOption[];
  /** The gpt low/medium/high lever exists only where the model has one. */
  supportsQuality: boolean;
  /** Boost is a choice only where a faster host actually exists. */
  boostAvailable: boolean;
  /** ...and at this size that host is not already the regular one. */
  boostAt: (tier: string) => boolean;
  /** Nothing is charged (free model, or the free route). */
  free: boolean;
  /** Keep a stored value inside the legal list (pickers call this in an
      effect so a model switch can never leave an unsupported pick behind). */
  clampRatio: (v: string) => string;
  clampTier: (v: string) => ResolutionTier;
};

export function useGenerationCore(
  idOrSlugOrName?: string,
  opts?: { allowAny?: boolean },
): GenerationCore {
  const catalogue = useModelCatalogue();
  const allowAny = opts?.allowAny === true;

  return useMemo(() => {
    const selected =
      catalogue.find((m) => m.name === idOrSlugOrName) ??
      resolveCatalogueEntry(catalogue, idOrSlugOrName);
    // What renders is the selection itself. A "free route" option used to
    // swap in the free model whatever was picked (Kev, 2026-10-02: "IMMER DAS
    // AUSGEWÄHLTE").
    const entry = selected;

    const baseRatios = entry?.ratios ?? FALLBACK_RATIOS;
    const ratios = allowAny ? ["Any", ...baseRatios] : baseRatios;
    const cap: ResolutionTier = entry?.maxResolution ?? "2K";
    // Free only when the server says the model renders on the free host. No
    // selection is not free; it is no selection.
    const free = entry?.free === true;
    // Prices are server quotes on each surface (useServerQuotes), never here.
    const tiers: TierOption[] = tiersUpTo(cap).map((t) => ({ tier: t }));

    return {
      catalogue,
      entry: selected,
      loading: catalogue.length === 0,
      ratios,
      tiers,
      supportsQuality: entry?.supportsQuality ?? false,
      boostAvailable: entry?.boostAvailable ?? false,
      boostAt: (tier) => boostAt(entry, tier),
      free,
      clampRatio: (v: string) => (ratios.includes(v) ? v : ratios[0]),
      clampTier: (v: string) => {
        const list = tiersUpTo(cap);
        return list.includes(v as ResolutionTier) ? (v as ResolutionTier) : list[list.length - 1];
      },
    };
  }, [catalogue, idOrSlugOrName, allowAny]);
}
