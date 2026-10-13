"use client";

import GeneratorLogo from "@/components/generation/GeneratorLogo";
import { quoteLabel } from "@/hooks/useServerQuotes";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { GenerationQuote } from "@/lib/generation-checkout";

/**
 * The generators the prompt offers, as toggles (Kev, 2026-10-13: "this must
 * be a multi-auswahl"): the first picked is the primary, saved as the prompt's
 * aiModel and where buyers start; the whole list goes out as aiModels. Only
 * these show in the test bar below and in the buyer's picker. Each chip
 * carries the server's price at the current settings, "$0.00" on the free host.
 */
export default function GeneratorRow({ models, selected, prices, onToggle }: {
  models: CatalogueEntry[];
  /** Catalogue ids in the order picked (listing.modelIds). */
  selected: string[];
  /** Server quotes at the current settings, aligned with `models`. */
  prices: Array<GenerationQuote | null>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="pe-row pe-gen-row">
      <span className="kit-label">Gen<span className="pe-wide-only">erators</span></span>
      <span className="pe-gens" role="group" aria-label="Generators on offer">
        {models.map((m, i) => {
          const on = selected.includes(m.id);
          const primary = selected[0] === m.id;
          return (
            // Colour alone marks on and primary: a chip never changes its words or width when pressed (Kev, 2026-10-13).
            <button key={m.id} type="button" role="checkbox" aria-checked={on} className="kit-pill kit-hit pe-gen" data-primary={primary || undefined}
              title={primary ? `${m.name} · primary: buyers start with it` : on ? `${m.name} · on offer` : `${m.name} · not on offer`}
              onClick={() => onToggle(m.id)}>
              <GeneratorLogo name={m.name} size={15} />
              {m.name}
              <span className="pe-gen-sub">{m.free ? "$0.00" : quoteLabel(prices[i]) ?? "…"}</span>
            </button>
          );
        })}
      </span>
      <span className="pe-note">buyers pick from these · the first you pick is where they start</span>
    </div>
  );
}
