/**
 * What "4K" means, in one place.
 *
 * Before this file each adapter invented its own answer and they disagreed by
 * more than an order of magnitude for the same request: Pollinations mapped 4K
 * to a 1024 base edge and then clamped it to ~0.59 MP, WaveSpeed forwarded the
 * opaque string "4k", Gemini attached an imageSize only for one hardcoded model
 * id, and OpenAI converted the tier to a pixel target of its own. A buyer who
 * picked 4K therefore got anything between 0.59 MP and 17 MP depending on which
 * host the router happened to choose, and nothing anywhere compared the two.
 *
 * The ceilings below are the providers' own documented limits, read 2026-08-13:
 *
 *  - gemini / gemini-3-pro-image — imageSize accepts "1K" | "2K" | "4K"
 *    (uppercase K is mandatory, "lowercase parameters will be rejected"). 4K is
 *    not square: 4096x4096 at 1:1, 5504x3072 at 16:9, 6336x2688 at 21:9.
 *  - wavespeed / nano-banana-pro and gpt-image-2 — `resolution` enum
 *    "1k" | "2k" | "4k", default 1k. 8k exists only on the -ultra endpoints,
 *    which nothing here routes to.
 *  - openai / gpt-image-2 — `size` takes arbitrary "WIDTHxHEIGHT" with a max
 *    edge of 3840 and a max total of 8,294,400 px, so 3840x2160 is the top.
 *  - pollinations / flux — the docs state no maximum at all; the real ceiling
 *    lives in the GPU worker as a total-pixel budget (MAX_PIXELS, 589,824).
 *    Nothing it returns can exceed 0.59 MP, so "4K" there is at most a
 *    fourteenth of a 4K frame. Running the adapter's own arithmetic against
 *    today's 512/768/1024 ladder: at 1:1 and 16:9 the 2K and 4K requests
 *    collapse onto the SAME image (768x768, 1024x576) because both overshoot
 *    the budget; at 4:5 they still differ, 614x768 against 687x859. The live
 *    rows show them fully identical at 4:5 too (686x858 for both), but those
 *    were recorded before the base ladder was restored, so treat them as
 *    history rather than as the current mapping. Either way the honest
 *    ceiling is 2K and offering 4K is a promise nothing can keep.
 */

export type ResolutionTier = "1K" | "2K" | "4K";

export const RESOLUTION_TIERS: readonly ResolutionTier[] = ["1K", "2K", "4K"];

const RANK: Record<ResolutionTier, number> = { "1K": 1, "2K": 2, "4K": 3 };

/**
 * A tier, or null for anything that is not one.
 *
 * Null rather than a default on purpose. The route this replaces cast the raw
 * client string straight to the union, so "4k" from the editor path reached
 * WaveSpeed's `RESOLUTION_MAP[...] ?? '1k'` and rendered at the SMALLEST tier
 * while the price ladder charged for the largest. A value that is not a tier
 * must be refused where it arrives, not quietly turned into one.
 */
export function normalizeTier(value: unknown): ResolutionTier | null {
  const s = String(value ?? "").trim().toUpperCase();
  return s === "1K" || s === "2K" || s === "4K" ? s : null;
}

/** Ceilings keyed by what actually determines them: provider + provider model. */
const MAX_BY_ROUTE: ReadonlyArray<{ provider: string; model: RegExp; max: ResolutionTier }> = [
  { provider: "gemini", model: /^gemini-3-pro-image(-preview)?$/, max: "4K" },
  { provider: "gemini", model: /^gemini-2\.5-flash-image$/, max: "1K" },
  { provider: "gemini", model: /^gemini-3\.1-flash-image$/, max: "4K" },
  { provider: "wavespeed", model: /^google\/nano-banana-pro\/(text-to-image|edit)$/, max: "4K" },
  { provider: "wavespeed", model: /^google\/nano-banana-2\/(text-to-image|edit)(-fast)?$/, max: "4K" },
  { provider: "wavespeed", model: /^openai\/gpt-image-2\/(text-to-image|edit)$/, max: "4K" },
  { provider: "openai", model: /^gpt-image-2/, max: "4K" },
  { provider: "pollinations", model: /./, max: "2K" },
];

/**
 * The largest tier this route genuinely renders.
 *
 * Unknown routes get 1K, not 4K. The bridge this replaces defaulted an
 * unrecognised model NAME to the Nano Banana Pro entry, so adding a row to the
 * models table was enough to have it billed by resolution against a host that
 * may ignore the field entirely. Failing closed costs a new model one line
 * here; failing open charges a buyer for pixels nobody sent.
 */
export function maxTier(provider: string | undefined, providerModel: string | undefined): ResolutionTier {
  const p = String(provider ?? "");
  const m = String(providerModel ?? "");
  return MAX_BY_ROUTE.find(r => r.provider === p && r.model.test(m))?.max ?? "1K";
}

/** The asked-for tier, or the route's ceiling when it cannot go that high. */
export function clampTier(
  asked: ResolutionTier,
  provider: string | undefined,
  providerModel: string | undefined
): ResolutionTier {
  const cap = maxTier(provider, providerModel);
  return RANK[asked] <= RANK[cap] ? asked : cap;
}

/** Every tier a route can honestly offer, for building a picker from. */
export function tiersUpTo(cap: ResolutionTier): ResolutionTier[] {
  return RESOLUTION_TIERS.filter(t => RANK[t] <= RANK[cap]);
}

/**
 * The tiers each audience can honestly be offered.
 *
 * Exported rather than re-declared per surface: six pickers used to carry
 * their own ["1K","2K","4K"] literal, so making one honest left five still
 * promising a size the route cannot render.
 */
export const FREE_TIERS: ResolutionTier[] = tiersUpTo(maxTier("pollinations", "flux"));

/* PAID_TIERS is gone: the paid checkout accepts 1K/2K/4K (quote and intent
   validate z.enum(["1K","2K","4K"]) since 2026-08-22), so paid pickers offer
   tiersUpTo(the model's ceiling) directly — 1K priced as 2K, the real
   provider fact (lib/pricing.toResolutionTier). */
