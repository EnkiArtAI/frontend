/**
 * Which generators the Image View offers, which one is in use, and how many
 * references it takes. No prompt stores a list of allowed generators (plan §5
 * #12): every image generator is offered, the prompt's own preselected.
 */
import { resolveCatalogueEntry, type CatalogueEntry } from "@/hooks/useModelLimits";

/* GET /api/prompts/[id] answers in the client's words (free -> free-prompt).
   A set, not an equality test on prompt_type: lib/payments' free-prompt-quote
   test bans that comparison anywhere under lib/, because on the server it
   would compare the stored word with the client's. */
const PUBLIC_TYPES = new Set(["free-prompt", "showcase"]);

/** A prompt whose text is public (the server's isPublicText, in the detail route's words). */
export const isFreePrompt = (p: { prompt_type?: string | null; is_free_showcase?: boolean | null }) =>
  p.is_free_showcase === true || PUBLIC_TYPES.has(p.prompt_type ?? "");

/* The free host renders only the text it is sent, never the artist's, so a
   premium prompt cannot run on it (Kev, 2026-10-08; generate-free answers 402). */
const offered = (m: CatalogueEntry, premium: boolean) => m.mediaType === "image" && !(premium && m.free);

/** The generators on offer, in catalogue order: every image model, on a premium prompt none on the free host. */
export const modelOptions = (catalogue: CatalogueEntry[], premium: boolean) => catalogue.filter((m) => offered(m, premium));

/**
 * The generator in use, by catalogue name: the buyer's pick whenever there is
 * one (nothing ever resets it), else the prompt's own model when it is on
 * offer, else none (""). The blank composer has no prompt and so no model of
 * its own: nothing is preselected there.
 */
export function defaultModel({ catalogue, pick, aiModel, premium }: {
  catalogue: CatalogueEntry[];
  pick: string;
  aiModel?: string | null;
  premium: boolean;
}): string {
  if (pick) return pick;
  const own = aiModel ? (catalogue.find((m) => m.name === aiModel) ?? resolveCatalogueEntry(catalogue, aiModel)) : undefined;
  return own && offered(own, premium) ? own.name : "";
}

/** How many of their own images a buyer may add: the model's own limit, never more than 4 (handoff §2). */
export const refCap = (entry: Pick<CatalogueEntry, "maxRefs"> | undefined) => Math.min(4, entry?.maxRefs ?? 0);

/**
 * The reference row at a cap: how many more fit (reads still pending count as
 * taken), how many are over it after a switch to a smaller model (flagged and
 * blocking Generate, never dropped), and whether an NFT may be picked at all.
 */
export const refSlots = (cap: number, refs: number, pending: number) => ({
  room: Math.max(0, cap - refs - pending),
  over: Math.max(0, refs - cap),
  nft: cap > 0,
});
