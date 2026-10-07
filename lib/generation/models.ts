/**
 * Which provider model a user's pick actually maps to.
 *
 * This is the piece that was missing: the editor sent `modelIds`, the route
 * used them for ratio validation only, and the generation then ran on whatever
 * the service happened to default to (a hard coded Gemini model). So "Nano Banana
 * Pro" and "GPT-Image-2" produced identical output from a third model, while
 * the price was charged per the user's selection.
 *
 * Config lives in the `models` table so a new generator is a row, not a
 * deploy — same principle as allowed_ratios and max_reference_images. The
 * slug map below is only a bridge for rows written before the provider columns
 * existed; it is not the source of truth.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { eligibleRoutes, pickRoute, type RouteLink, type RouteCandidate } from "@/lib/generation/routing";
import { loadHealth, breakerVerdict, runProbe } from "@/lib/generation/provider-health";
import { canCarryReferenceImages } from "@/lib/generation/provider-capabilities";
import { maxTier, tiersUpTo, type ResolutionTier } from "@/lib/generation/resolution";
import { toModelFamily } from "@/lib/generation/model-family";

/** "none" = no route at all: a model with no provider rows and no bridge entry. */
export type Provider = "gemini" | "openai" | "wavespeed" | "pollinations" | "acedata" | "none";

export interface Route {
  provider: Provider;
  /** The provider's own model id, e.g. "gemini-3-pro-image". */
  providerModel: string;
  /**
   * The model_providers row this came from, and its provider. Carried so the
   * circuit breaker can be told which ROUTE succeeded or failed — health is
   * per route, because an aggregator hosts each model on a different upstream
   * and they fail independently.
   */
  modelProviderId?: string;
  providerId?: string;
}

export interface ResolvedModel {
  /** Row id in `models`, when it came from the database. */
  id: string | null;
  /** Display name, e.g. "Nano Banana Pro". */
  name: string;
  /**
   * The same model can be reached two ways, and that is the product:
   *   normal — WaveSpeed, cheaper, ~73-78s
   *   boost  — the vendor directly, dearer, ~19-39s
   * Boost picks WHERE the model runs, never WHICH model runs, so the picture
   * a user gets is the same either way. Measured 2026-08-06 on the same
   * prompt; where a model has no WaveSpeed host, both routes are the same.
   */
  normal: Route;
  boost: Route;
  allowedRatios: string[];
  maxRefs: number;
  /**
   * Every model_providers row for this model, unfiltered. chooseRoute() walks
   * them per request; normal/boost above stay as the settings-independent
   * answer everything else already depends on.
   */
  links?: unknown[];
  /** True when the model honours a size/resolution request. */
  supportsResolution: boolean;
  /**
   * The largest tier this model genuinely renders, so a picker can offer the
   * sizes that exist instead of a fixed 1K/2K/4K list. Flux caps at 2K: its
   * worker clamps on total pixels, so a 4K request there never exceeds 0.59 MP.
   */
  maxResolution: ResolutionTier;
  /**
   * True when the model takes a low|medium|high quality tier as its OWN
   * parameter. Only the gpt-image family does — on both hosts. For Gemini the
   * concept does not exist, and offering a control that changes nothing is the
   * kind of lie this file was written to remove.
   */
  supportsQuality: boolean;
}

/** The route to use for this request. */
export function routeFor(model: ResolvedModel, boost: boolean | undefined): Route {
  return boost ? model.boost : model.normal;
}

/**
 * The sizes at which boost actually does something: the boost route differs
 * from the normal route policy would run at that size.
 *
 * Derived, never stored. A column saying "has boost" would be a second truth
 * next to the model_providers rows, and two truths drift: someone deletes the
 * boost row and the flag still says yes, so the UI offers a paid speed-up that
 * changes nothing. The rows ARE the answer. Per size, because a route may be
 * conditioned on it: Nano Banana 2 runs WaveSpeed Fast at 2K/4K and Google at
 * 1K, where Google is also the boost host, so at 1K there is nothing to boost
 * and the button shows disabled (Kev, 2026-10-06).
 */
export function boostTiers(model: ResolvedModel, audience: Audience = "public"): ResolutionTier[] {
  const links = (model.links ?? []) as RouteLink[];
  const first = (tier: ResolutionTier, boost: boolean): Route => {
    const c = eligibleRoutes(links, { resolution: tier }, boost ? "boost" : "normal", audience)[0];
    return c ? toRoute(c) : routeFor(model, boost);
  };
  return tiersUpTo(model.maxResolution).filter((tier) => {
    const n = first(tier, false);
    const b = first(tier, true);
    return n.provider !== b.provider || n.providerModel !== b.providerModel;
  });
}

/** Does boost do anything for this model at any size? */
export function hasBoost(model: ResolvedModel): boolean {
  return boostTiers(model).length > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Bridge for rows that predate models.provider_model. Measured 2026-08-06:
 * gemini-3-pro-image honours imageSize (1K 1024², 2K 2048², 4K 4096²).
 * The GA id gemini-3-pro-image replaced the preview id Google shut down on
 * 2026-06-25; migrations/2026-08-12-reference-image-limits.sql renamed the rows.
 */
const BY_SLUG: Record<string, Pick<ResolvedModel, "normal" | "boost" | "supportsResolution" | "supportsQuality">> = {
  "nano-banana-pro": {
    // Gemini direct is the primary host since 2026-09-05: WaveSpeed raised
    // 1K/2K to $0.14 while Gemini stays $0.134 — and Gemini was already the
    // 2-4x faster host boost used to sell. Cheapest and fastest coincide, so
    // boost === normal and the toggle disappears; the WaveSpeed row in
    // model_providers stays as the outage fallback.
    normal: { provider: "gemini", providerModel: "gemini-3-pro-image" },
    boost: { provider: "gemini", providerModel: "gemini-3-pro-image" },
    supportsResolution: true,
    supportsQuality: false,
  },
  "gpt-image-2": {
    // OpenAI direct on every quality since 2026-09-05: WaveSpeed replaced its
    // flat $0.167/$0.25 with a quality matrix whose high cells ($0.40/$0.72)
    // would have lost money against what we charged, and its remaining
    // advantage over OpenAI's measured cells is 1-3 cents in two cells — not
    // worth a second, unmeasured host. WaveSpeed stays in model_providers as
    // the outage fallback. boost === normal: the cheapest host is already the
    // fastest, so hasBoost() is false and the toggle stays hidden.
    normal: { provider: "openai", providerModel: "gpt-image-2" },
    boost: { provider: "openai", providerModel: "gpt-image-2" },
    // OpenAI takes pixels rather than a tier; the service converts, so the
    // resolution the user picks really does change the image.
    supportsResolution: true,
    // low | medium | high, accepted by BOTH hosts — verified live 2026-08-06.
    // It is also the real price lever on OpenAI: roughly 0.006 / 0.053 / 0.211
    // USD at 1024², a 35x spread. AceData is the exception — measured
    // 2026-08-06, quality changes neither its price nor its output there.
    supportsQuality: true,
  },
  "flux-free": {
    // The free generator is a provider like any other (Kev, 2026-08-06), not a
    // branch in the code. No faster host exists, so boost is the same route
    // and hasBoost() reports false — the button never appears for it.
    normal: { provider: "pollinations", providerModel: "flux" },
    boost: { provider: "pollinations", providerModel: "flux" },
    /* "Honoured in spirit" was the old claim here, and it is false. The
       worker clamps on TOTAL pixels before diffusing, so nothing this route
       returns exceeds 0.59 MP — at 1:1 and 16:9 a 2K and a 4K request come
       back as the very same image. The ceiling that matters now lives in
       lib/generation/resolution.ts, which caps this route at 2K. */
    supportsResolution: true,
    supportsQuality: false,
  },
};

/* There is no fallback model (Kev, 2026-10-02): a selection that cannot be
   resolved is refused, never replaced. These are only column defaults for
   rows that predate allowed_ratios and max_reference_images. */
const DEFAULT_RATIOS = ["1:1", "16:9", "9:16"];
const DEFAULT_MAX_REFS = 3;


/** A row of model_providers with its provider embedded. */
interface LinkRow {
  id?: string | null;
  role?: string | null;
  provider_model?: string | null;
  active?: boolean | null;
  priority?: number | null;
  applies_when?: Record<string, string[]> | null;
  provider_id?: string | null;
  providers?: {
    id?: string | null;
    key?: string | null;
    audience?: string | null;
    active?: boolean | null;
  } | null;
}

interface ModelRow {
  id?: string;
  name?: string;
  allowed_ratios?: string[] | null;
  max_reference_images?: number | null;
  model_providers?: LinkRow[] | null;
}

/** Who the caller is allowed to be routed to. */
export type Audience = "public" | "enterprise" | "internal";

function linkToRoute(link: LinkRow | undefined, audience: Audience): Route | null {
  if (!link || link.active === false) return null;
  const p = link.providers;
  if (!p?.key || p.active === false) return null;
  // An enterprise-only host must stay invisible to a normal account even when
  // a model lists it — otherwise the routing quietly grants access the
  // customer never bought.
  const want = (p.audience as Audience) ?? "public";
  if (want !== "public" && want !== audience) return null;
  if (!link.provider_model) return null;
  return {
    provider: p.key as Provider,
    providerModel: link.provider_model,
    modelProviderId: link.id ?? undefined,
    providerId: link.provider_id ?? p.id ?? undefined,
  };
}

/* A row the bridge does not know and that has no provider rows gets no route,
   not Nano Banana Pro's (the old fallback): a paid request never runs on a
   guessed model (Kev, 2026-09-22). "none" is no implemented provider, so the
   routes refuse it before any payment step. */
const NO_ROUTE: Pick<ResolvedModel, "normal" | "boost" | "supportsResolution" | "supportsQuality"> = {
  normal: { provider: "none", providerModel: "" },
  boost: { provider: "none", providerModel: "" },
  supportsResolution: false,
  supportsQuality: false,
};

function fromRow(row: ModelRow, audience: Audience): ResolvedModel {
  const bridge = BY_SLUG[slug(row.name ?? "")] ?? NO_ROUTE;
  // Lowest priority first: the default route is the one routing tries first,
  // not whichever row the database happens to return first.
  const links = [...(row.model_providers ?? [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  // The database is the truth once the providers migration has run; the slug
  // bridge only covers the window before that.
  const normal =
    linkToRoute(links.find((l) => l.role === "normal"), audience) ?? bridge.normal;
  // No boost row means this model simply has no faster host. Falling back to
  // `normal` makes boost a no-op instead of an error, and instead of silently
  // routing somewhere the row never named.
  const boost =
    linkToRoute(links.find((l) => l.role === "boost"), audience) ??
    (row.model_providers?.length ? normal : bridge.boost);

  return {
    id: row.id ?? null,
    name: row.name ?? "",
    normal,
    boost,
    // The raw rows travel with the model because the ORDERED choice cannot be
    // made here: which route is cheapest depends on the quality and resolution
    // of the request, which fromRow never sees.
    links,
    allowedRatios: row.allowed_ratios?.length ? row.allowed_ratios : DEFAULT_RATIOS,
    maxRefs: typeof row.max_reference_images === "number" ? row.max_reference_images : DEFAULT_MAX_REFS,
    /* Derived from the ROUTE, never from a column and no longer from the
       display-name bridge. Whether a model honours a resolution is a fact
       about the provider and the provider model, and the bridge answered it
       by slugging row.name with a fallback to the Nano Banana Pro entry — so
       any name it did not recognise inherited supportsResolution: true and
       was billed by resolution against a host that may ignore the field.
       lib/generation/resolution.ts fails closed at 1K instead. */
    supportsResolution: maxTier(normal.provider, normal.providerModel) !== "1K",
    maxResolution: maxTier(normal.provider, normal.providerModel),
    supportsQuality: bridge.supportsQuality,
  };
}


/**
 * Catalogue rows for /api/models: the raw fields the UI already reads, plus
 * the CAPABILITY facts resolved the same way the generation itself resolves
 * them. The pickers were deriving these client-side — supportsQuality from a
 * name regex, resolution tiers from a hardcoded list — which is exactly the
 * split-brain this file exists to prevent: the server would honour one answer
 * while the UI offered another (Kev, 2026-08-19: "das soll doch eher derived
 * from the database sein").
 */
/* Every ratio the image APIs accept (mirrors backend/services/types.ts).
   Dimension-free hosts compute width x height from ANY of these. */
const FULL_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

export function withCapabilities(rows: ModelRow[], audience: Audience = "public") {
  return rows.map((row) => {
    const m = fromRow(row, audience);
    // The embed rides in for fromRow and stays out of the response: the UI
    // needs the answers, not the provider wiring behind them.
    const { model_providers: _links, ...raw } = row as ModelRow & { model_providers?: unknown };
    /* Ratio capability belongs to the HOST, not the row: pollinations builds
       free-form dimensions from any ratio (backend getDimensions), so a
       curated allowed_ratios list on the free model only narrowed what the
       API genuinely takes — and needed manual SQL to keep in sync (Kev,
       2026-08-23: "koennen wir die nicht von der api deriven?"). Derived
       here; the DB list still rules hosts with a real enum (gemini). */
    if (m.normal.provider === "pollinations") {
      (raw as Record<string, unknown>).allowed_ratios = FULL_RATIOS;
    }
    const boostAt = boostTiers(m, audience);
    return {
      ...raw,
      maxResolution: m.maxResolution,
      supportsResolution: m.supportsResolution,
      supportsQuality: m.supportsQuality,
      // Derived from the provider rows, never stored: the boost toggle shows
      // only where a faster host exists, and is enabled only at the sizes
      // where that host is not already the regular one.
      boostAvailable: boostAt.length > 0,
      boostTiers: boostAt,
      // The one fact that sends a generation to /api/generate-free: the model
      // renders on the free host. Never inferred from a price.
      free: m.normal.provider === "pollinations",
    };
  });
}

/**
 * The model a PAYMENT is for, resolved from the family key on its intent.
 *
 * The paid caller sends { intentId, prompt, aspectRatio } and NO modelIds — it
 * already told the server which model it was buying when it took the quote.
 * resolveModel() with no ids used to fall back to a default model, so comparing
 * that fallback against the paid family refused every purchase of anything
 * except the default. The intent is the source of truth; this reads it.
 *
 * Returns null rather than a default when the family names nothing active.
 * Quietly generating on some other model is precisely the failure the family
 * check exists to prevent, and a default here would reintroduce it.
 */
export async function resolveModelByFamily(
  supabase: SupabaseClient | null,
  family: string,
  audience: Audience = "public",
): Promise<ResolvedModel | null> {
  if (!supabase || !family) return null;
  try {
    const { data, error } = await supabase
      .from("models")
      .select(
        "id, name, allowed_ratios, max_reference_images, " +
        "model_providers(id, role, provider_model, active, priority, applies_when, provider_id, providers(id, key, audience, active))",
      )
      .eq("active", true);
    if (error || !data?.length) return null;
    /* Matched on the slug, not the display name: "GPT-Image-2 (coming soon)"
       and "GPT-Image-2" are the same purchase, and the quote stored the slug
       precisely so that editing a label is not a pricing event. */
    const rows = (data as unknown as ModelRow[]).filter(
      (r) => toModelFamily(String(r.name ?? "")) === family,
    );
    // Two active rows answering to one family is a choice we may not make for
    // the caller: whichever came first would run with its own routes.
    return rows.length === 1 ? fromRow(rows[0], audience) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the user's selection: exactly the FIRST id. A generation runs on
 * one model, and when that row is missing or inactive the answer is null,
 * never the next id in the list (Kev, 2026-10-02: "IMMER DAS AUSGEWÄHLTE").
 */
export async function resolveModel(
  supabase: SupabaseClient | null,
  modelIds: string[] | undefined,
  audience: Audience = "public",
): Promise<ResolvedModel | null> {
  // Exact row ids only. A name or slug is not an id, and a failed lookup is
  // refused by the caller, never replaced by another model (Kev, 2026-10-02).
  const first = modelIds?.[0];
  if (!supabase || !first || !UUID.test(first)) return null;
  const ids = [first];
  try {
    const pick = (cols: string) =>
      supabase.from("models").select(cols).in("id", ids).eq("active", true);

    // Embed the provider links. Asking for a relation that does not exist
    // fails the whole query, so the fallback is a plain select — that is the
    // window before the providers migration has run, where the slug bridge in
    // fromRow() takes over.
    let rows: ModelRow[];
    const joined = await pick(
      "id, name, allowed_ratios, max_reference_images, " +
      "model_providers(id, role, provider_model, active, priority, applies_when, provider_id, providers(id, key, audience, active))",
    );
    if (joined.error) {
      const flat = await pick("id, name, allowed_ratios, max_reference_images");
      rows = (flat.data ?? []) as unknown as ModelRow[];
    } else {
      rows = (joined.data ?? []) as unknown as ModelRow[];
    }
    const row = rows.find((r) => r.id === first);
    return row ? fromRow(row, audience) : null;
  } catch {
    return null;
  }
}

/** Exposed for tests: the pure row -> route mapping, without a database. */
export const __testing__ = { fromRow, linkToRoute };

/**
 * The route this request should actually run on: cheapest first, skipping
 * hosts whose breaker is open, probing one that is due.
 *
 * routeFor() above still answers the settings-independent question everything
 * else asks. This is the one the generation itself uses, because which host is
 * cheapest depends on the quality and resolution being requested — AceData's
 * flat gpt-image-2 price loses at 1K and wins from 2K up.
 *
 * Falls back to routeFor() whenever the ordered list cannot be built: no
 * priority columns yet, no matching row, everything down. Delivering the image
 * matters more than delivering it cheaply.
 *
 * Returns NULL in exactly one case: the request carries reference images and no
 * host — not the ordered candidates, not the fallback — can pass them to the
 * model. Null rather than a route the caller might use anyway, because the
 * fallback path is precisely how the silent drop used to happen: candidates
 * came back empty and routeFor() handed over WaveSpeed, which discards them.
 * A nullable return makes the compiler force every caller to decide.
 */
export async function chooseRoute(
  supabase: SupabaseClient | null,
  model: ResolvedModel,
  opts: {
    boost?: boolean;
    quality?: string | null;
    resolution?: string | null;
    /** How many reference images the request carries. */
    referenceImages?: number;
  },
  audience: Audience = "public",
): Promise<Route | null> {
  const refs = opts.referenceImages ?? 0;
  const rawFallback = routeFor(model, opts.boost);
  // The fallback is a route like any other and gets the same capability test.
  const fallback = canCarryReferenceImages(rawFallback.provider, refs) ? rawFallback : null;

  const links = (model.links ?? []) as RouteLink[];
  if (!supabase || links.length === 0) return fallback;

  const candidates = eligibleRoutes(
    links,
    { quality: opts.quality, resolution: opts.resolution },
    opts.boost ? "boost" : "normal",
    audience,
    { referenceImages: refs },
  );
  if (candidates.length === 0) return fallback;

  const health = await loadHealth(
    supabase,
    candidates.map((c) => c.id).filter(Boolean),
  );
  const now = Date.now();
  const { chosen, probe } = pickRoute(candidates, (id) =>
    breakerVerdict(health.get(id) ?? null, now),
  );

  // A route that is due a probe gets one before we spend more of the buyer's
  // money elsewhere: the x402 quote is free and takes about 200ms, so asking
  // is cheaper than assuming it is still down.
  for (const c of probe) {
    const alive = await runProbe(supabase, c.id, c.providerId, c.providerKey, c.providerModel);
    if (alive) return toRoute(c);
  }

  return chosen ? toRoute(chosen) : fallback;
}

const toRoute = (c: RouteCandidate): Route => ({
  provider: c.providerKey as Provider,
  providerModel: c.providerModel,
  modelProviderId: c.id,
  providerId: c.providerId,
});
