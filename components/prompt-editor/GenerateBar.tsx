"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Dice5 } from "lucide-react";
import BoostToggle from "@/components/generation/BoostToggle";
import CostLine from "@/components/kit/CostLine";
import GenerateButton from "@/components/kit/GenerateButton";
import GeneratorPill from "@/components/kit/GeneratorPill";
import { QualityPill, RatioPill, ResolutionPill } from "@/components/kit/SettingsPills";
import { useToastOffset } from "@/components/kit/notify";
import type { GenerationCore } from "@/hooks/useGenerationCore";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { RenderPicks } from "@/lib/editor/generate-checks";
import type { GenerationQuote } from "@/lib/generation-checkout";

type Quotes = Array<GenerationQuote | null>;

/**
 * The bottom of Craft, sticky: the live strip (below 1024 px), the test
 * generator and its settings, Vary, Boost, Generate with the price it
 * charges, and the cost line. The row wraps and never scrolls sideways.
 * Toasts sit above it, and a pane scrolled to the end follows when the bar
 * grows, so the references stay in view above the strip (handoff §5).
 */
export default function GenerateBar({ live, models, testId, onTest, core, picks, onPicks, prices, vary, generate, cost, children }: {
  live: ReactNode;
  /** The generators on offer (GeneratorRow's picks): the test generator is one of them. */
  models: CatalogueEntry[];
  testId: string | null;
  onTest: (id: string) => void;
  /** The test generator's options (useGenerationCore). */
  core: GenerationCore;
  picks: RenderPicks;
  onPicks: (patch: Partial<RenderPicks>) => void;
  /** Server quotes: per model (aligned with `models`), per tier of the test generator, per quality. */
  prices: { models: Quotes; tiers: Quotes; qualities: Quotes };
  vary: { onVary: () => void; rolling: boolean; unavailable: boolean };
  generate: ComponentProps<typeof GenerateButton>;
  cost: ComponentProps<typeof CostLine>;
  /** The low-balance prompt, which sits above this block. */
  children?: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useToastOffset(height === null ? null : height + 12);

  useEffect(() => {
    const el = bar.current;
    const pane = el?.parentElement;
    if (!el || !pane) return;
    let was = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const grew = el.offsetHeight - was;
      was = el.offsetHeight;
      setHeight(was);
      if (grew > 0 && pane.scrollHeight - pane.scrollTop - pane.clientHeight - grew < 140) pane.scrollTop = pane.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tier = core.clampTier(picks.resolution);
  return (
    <div ref={bar} className="pe-bar">
      {live}
      <div className="pe-bar-row">
        <GeneratorPill models={models} value={testId} onChange={onTest} prices={prices.models} look="logo" direction="up"
          placeholder={models.length ? "Pick a generator" : "Pick generators above"} disabled={!models.length}
          title="Test generator" hint="Renders your test images · the price follows it" />
        <RatioPill core={core} value={picks.ratio} onChange={(ratio) => onPicks({ ratio })} />
        <ResolutionPill core={core} value={picks.resolution} onChange={(resolution) => onPicks({ resolution })} prices={prices.tiers} />
        {core.supportsQuality && (
          <QualityPill value={picks.quality ?? "medium"} onChange={(quality) => onPicks({ quality })} prices={prices.qualities} />
        )}
        <button type="button" className="kit-pill kit-hit pe-vary" onClick={vary.onVary}
          disabled={vary.rolling || vary.unavailable} data-rolling={vary.rolling || undefined}
          title={vary.unavailable ? "Vary is not configured on this deployment" : "The AI writes new values into your variables. Check them, then Generate. Undo any time."}>
          <Dice5 size={16} strokeWidth={2} aria-hidden />Vary
        </button>
        <BoostToggle label boost={picks.boost} onChange={(boost) => onPicks({ boost })}
          available={core.boostAvailable} sameHost={!core.boostAt(tier)} />
        <GenerateButton {...generate} />
      </div>
      <CostLine {...cost} />
      {children}
    </div>
  );
}
