"use client";

import GeneratorPill from "@/components/kit/GeneratorPill";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { GenerationQuote } from "@/lib/generation-checkout";

/**
 * The generator the prompt is made for, saved as its aiModel. A prompt stores
 * one, and buyers may switch to any image generator, so there is no "also"
 * list to tick (plan §5 item 1): one grey line says so.
 */
export default function GeneratorRow({ models, value, prices, onPick }: {
  models: CatalogueEntry[];
  value: string | null;
  /** Server quotes at the current settings, aligned with `models`. */
  prices: Array<GenerationQuote | null>;
  onPick: (id: string) => void;
}) {
  return (
    <div className="pe-row pe-gen-row">
      <span className="kit-label">Gen<span className="pe-wide-only">erator</span></span>
      <span className="pe-primary">
        <GeneratorPill models={models} value={value} onChange={onPick} prices={prices} look="named" direction="down"
          title="Primary generator" hint="Saved with your prompt · buyers start with it" />
      </span>
      <span className="pe-note">people can switch to any generator</span>
    </div>
  );
}
