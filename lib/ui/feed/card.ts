import { isPublicText } from "@/lib/prompt-visibility";
import { boxRatio } from "@/lib/ui/kit/ratio";
import type { ImageViewSeed } from "@/lib/ui/image-view/seed";

/** A feed card as the payload states it. What the payload does not carry is
 *  empty or null, never filled in: no placeholder image, no made-up text. */
export interface FeedCard {
  id: string;
  /** Trimmed; "" when untitled, which the card shows as "Untitled prompt". */
  title: string;
  /** Integer cents; null when missing or malformed, and then no chip. */
  priceCents: number | null;
  /** prompts.category, lowercased like the category chips. */
  category: string;
  /** Showcase URLs, then preview URLs, each once. */
  images: string[];
  /** Width over height of the card's box, known before the image loads. */
  ratio: number;
  creator: { id: string; handle: string; name: string } | null;
  /** The prompt's words are public (free or showcase). */
  publicText: boolean;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const cents = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const urls = (v: unknown) => (Array.isArray(v) ? v : []).map((i) => str(typeof i === "string" ? i : rec(i).url));

/** One row of /api/marketplace/prompts or /api/search; null without an id. */
export function toFeedCard(raw: unknown): FeedCard | null {
  const r = rec(raw);
  const id = str(r.id);
  if (!id) return null;
  const c = rec(r.creator);
  const handle = str(c.handle);
  const creatorId = str(c.id);
  return {
    id,
    title: str(r.title),
    priceCents: cents(r.priceUsdCents),
    category: str(r.category).toLowerCase(),
    images: [...new Set([...urls(r.showcaseImages), ...urls(r.previewImages)])].filter(Boolean),
    ratio: boxRatio(str(r.aspectRatio)),
    creator: creatorId || handle ? { id: creatorId, handle, name: str(c.displayName) || handle } : null,
    publicText: isPublicText({ prompt_type: r.promptType, is_free_showcase: r.isFreeShowcase }),
  };
}

/** The card's price chip: "Open" at 0 cents (an open prompt; Kev, 2026-10-13:
 *  "free aka Open"), "$0.40" otherwise, and none for a price that is not
 *  whole cents (the card never guesses). */
export function priceChipLabel(v: unknown): string | null {
  const c = cents(v);
  return c === null ? null : c === 0 ? "Open" : `$${(c / 100).toFixed(2)}`;
}

/** What the Image View paints while /api/prompts/[id] loads. */
export function seedFromFeedCard(card: FeedCard): ImageViewSeed {
  const by = card.creator;
  return {
    promptId: card.id,
    title: card.title || undefined,
    artist: by ? { handle: by.handle || undefined, name: by.name || undefined, id: by.id || undefined } : undefined,
    imageUrl: card.images[0],
    showcase: card.images,
    isFree: card.publicText,
  };
}
