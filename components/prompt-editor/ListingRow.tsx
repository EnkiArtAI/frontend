"use client";

import PillMenu from "@/components/kit/PillMenu";
import Segmented from "@/components/kit/Segmented";
import { ENKI_CATEGORIES } from "@/lib/categories";
import type { Listing } from "@/lib/editor/release";
import PriceStepper from "./PriceStepper";

/** What each mode means; the hover text, and a toast on a touch screen, where nothing hovers. "Open" is the word for a public text (Kev, 2026-10-13: "swap Free prompt to Open"). */
export const MODE_TITLE: Record<Listing["mode"], string> = {
  free: "Open: your prompt text is public; people pay only the generator. Release with 1 image.",
  premium: "Your text stays private; people pay your price on top of the generator. Release with 4 images.",
};

/** Open | Premium, the price (Premium only) and the category, from the live list (plan §5 item 10). */
export default function ListingRow({ listing, onMode, onPrice, onCategory }: {
  listing: Listing;
  onMode: (mode: Listing["mode"]) => void;
  onPrice: (price: number) => void;
  onCategory: (category: string) => void;
}) {
  return (
    <div className="pe-row pe-listing">
      <Segmented slide role="radiogroup" ariaLabel="Listing" value={listing.mode} onChange={onMode} options={[
        { key: "free", label: "Open", title: MODE_TITLE.free },
        { key: "premium", label: <><span className="pe-diamond" aria-hidden />Premium</>, title: MODE_TITLE.premium },
      ]} />
      {/* The price slides out of the switch on Premium and back in on Open, the category following (Kev, 2026-10-13). Inert while in: not in the tab order. */}
      <span className="pe-price-slot" data-open={listing.mode === "premium" || undefined} inert={listing.mode !== "premium" || undefined}>
        <span className="pe-price-slot-in"><PriceStepper price={listing.price} onPrice={onPrice} /></span>
      </span>
      <span className="pe-category">
        <PillMenu
          trigger={listing.category ?? <span className="pe-unset">Category</span>}
          ariaLabel={listing.category ? `Category: ${listing.category}` : "Category · where your prompt shows up in the feed"}
          title="Category"
          hint="Where your prompt shows up"
          columns={2}
          direction="down"
          options={ENKI_CATEGORIES.map((c) => ({ key: c, label: c }))}
          value={listing.category}
          onPick={onCategory}
        />
      </span>
    </div>
  );
}
