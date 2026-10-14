"use client";

import { Gem } from "lucide-react";
import RatioRect from "@/components/generation/RatioRect";
import type { GenerationCore } from "@/hooks/useGenerationCore";
import { quoteLabel } from "@/hooks/useServerQuotes";
import type { GenerationQuote } from "@/lib/generation-checkout";
import type { ResolutionTier } from "@/lib/generation/resolution";
import { tierOptions } from "@/lib/ui/kit/controls";
import PillMenu from "./PillMenu";

/* Ratio, resolution and quality pills. Every option comes from the
   generation core (useGenerationCore), every price from the caller's server
   quotes; nothing model-specific lives here. A stored value outside the
   model's list shows clamped, the way the caller sends it (R10). */

export function RatioPill({ core, value, onChange }: {
  core: GenerationCore;
  value: string;
  onChange: (ratio: string) => void;
}) {
  const v = core.clampRatio(value);
  return (
    <PillMenu
      trigger={<><RatioRect ratio={v} size={14} /><span>{v}</span></>}
      ariaLabel={`Aspect ratio ${v}`}
      title="Aspect ratio"
      columns={2}
      options={core.ratios.map((r) => ({ key: r, label: r, icon: <RatioRect ratio={r} size={15} /> }))}
      value={v}
      onPick={onChange}
    />
  );
}

export function ResolutionPill({ core, value, onChange, prices }: {
  core: GenerationCore;
  value: string;
  onChange: (tier: ResolutionTier) => void;
  /** Quotes per tier, aligned with `core.tiers`. */
  prices: Array<GenerationQuote | null>;
}) {
  const v = core.clampTier(value);
  return (
    <PillMenu
      trigger={<span>{v}</span>}
      ariaLabel={`Resolution ${v}`}
      title="Resolution"
      options={tierOptions(
        core.tiers.map((t) => t.tier),
        core.entry?.name ?? "this generator",
        core.tiers.map((_, i) => (core.free ? "$0.00" : quoteLabel(prices[i]))),
      )}
      value={v}
      onPick={(t) => onChange(t as ResolutionTier)}
    />
  );
}

type Quality = "low" | "medium" | "high";
const QUALITIES: Quality[] = ["low", "medium", "high"];
const QUALITY_LABEL: Record<Quality, string> = { low: "Low", medium: "Mid", high: "High" };

/** Only for a model with its own quality lever (`core.supportsQuality`). */
export function QualityPill({ value, onChange, prices }: {
  value: Quality;
  onChange: (quality: Quality) => void;
  /** Quotes per quality: low, medium, high. */
  prices: Array<GenerationQuote | null>;
}) {
  return (
    <PillMenu
      trigger={<><Gem size={13} strokeWidth={2.2} aria-hidden /><span>{QUALITY_LABEL[value]}</span></>}
      ariaLabel={`Quality ${QUALITY_LABEL[value]}`}
      title="Quality"
      options={QUALITIES.map((q, i) => ({ key: q, label: QUALITY_LABEL[q], sub: quoteLabel(prices[i]) }))}
      value={value}
      onPick={(q) => onChange(q as Quality)}
    />
  );
}
