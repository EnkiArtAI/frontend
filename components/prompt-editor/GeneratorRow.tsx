"use client";

import GeneratorLogo from "@/components/generation/GeneratorLogo";
import PillMenu from "@/components/kit/PillMenu";
import { quoteLabel } from "@/hooks/useServerQuotes";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { GenerationQuote } from "@/lib/generation-checkout";

/**
 * The generators the prompt offers: one pill, a menu of checkboxes that
 * stays open while they are ticked (Kev, 2026-10-13: "ein Dropdown-Menü mit
 * Checkboxes"; the chips before it moved as their prices loaded). There is
 * no primary generator: buyers get the settings of the image they look at.
 * The whole list goes out as aiModels; the test bar below offers only these.
 */
export default function GeneratorRow({ models, selected, prices, onToggle }: {
  models: CatalogueEntry[];
  /** Catalogue ids on offer (listing.modelIds). */
  selected: readonly string[];
  /** Server quotes at the current settings, aligned with `models`. */
  prices: Array<GenerationQuote | null>;
  onToggle: (id: string) => void;
}) {
  const names = models.filter((m) => selected.includes(m.id)).map((m) => m.name);
  const face = !names.length ? <span className="kit-unset">Pick generators</span>
    : names.length <= 2 ? names.join(" · ") : `${names.length} generators`;
  return (
    <div className="pe-row pe-gen-row">
      <span className="kit-label">Gen<span className="pe-wide-only">erators</span></span>
      <PillMenu
        trigger={face}
        ariaLabel={names.length ? `Generators on offer: ${names.join(", ")}` : "Pick the generators buyers may use"}
        title="Generators on offer"
        hint="Buyers pick from these"
        direction="down"
        options={models.map((m, i) => ({ key: m.id, label: m.name, icon: <GeneratorLogo name={m.name} size={15} />, sub: m.free ? "$0.00" : quoteLabel(prices[i]) }))}
        value={null}
        selected={selected}
        onPick={onToggle}
      />
      <span className="pe-note">buyers pick from these</span>
    </div>
  );
}
