"use client";

/**
 * Per-model generation limits from the models table (max reference images +
 * allowed file types), fetched once via /api/models and cached module-wide.
 *
 * UI model ids are slugs ("nano-banana-pro") while the DB stores display
 * names ("Nano Banana Pro") — matching is slug-normalized both ways.
 * Fail-open to sane defaults so the UIs work before the migration ran.
 */
import { useEffect, useState } from "react";
import { toModelFamily } from "@/lib/generation/model-family";

export interface ModelLimits {
  maxRefs: number;
  filetypes: string[];
  /** value for <input accept> */
  accept: string;
  /**
   * Ratios this generator actually accepts. Every generator takes a different
   * set, so the list belongs in the database next to the model, not in a
   * constant in the UI — offering a ratio the provider rejects fails the call
   * AFTER the payment has settled.
   */
  ratios: string[];
}

/**
 * The intersection every current provider supports — offered only while a
 * model has no list of its own. Deliberately narrow: a ratio offered here and
 * rejected by the provider fails the call after the payment has settled.
 */
export const FALLBACK_RATIOS = ["1:1", "16:9", "9:16"];

const DEFAULTS: ModelLimits = {
  maxRefs: 14,
  filetypes: ["image/png", "image/jpeg", "image/webp"],
  accept: "image/png,image/jpeg,image/webp",
  ratios: FALLBACK_RATIOS,
};

interface ModelRow {
  id?: string;
  price?: number;
  name?: string;
  max_reference_images?: number;
  allowed_filetypes?: string[];
  allowed_ratios?: string[];
  /** Resolved server-side by /api/models via withCapabilities(). */
  maxResolution?: string;
  supportsQuality?: boolean;
  boostAvailable?: boolean;
  free?: boolean;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

let cache: { rows: ModelRow[]; at: number } | null = null;
let inflight: Promise<ModelRow[]> | null = null;

async function loadModels(): Promise<ModelRow[]> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.rows;
  if (!inflight) {
    inflight = fetch("/api/models")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: ModelRow[]) => {
        const list = Array.isArray(rows) ? rows : [];
        /* Cache ONLY a real answer. A failure or an empty list must not be
           remembered: /api/models 401s until the gate cookie is set, and the
           editor hits this hook on the way in — so caching [] poisoned every
           picker for five minutes down to the single-entry fallback, which is
           the "only Nano Banana Pro" Kev saw. Leaving the cache null lets the
           next mount retry instead. */
        if (list.length > 0) cache = { rows: list, at: Date.now() };
        return list.length > 0 ? list : cache?.rows ?? [];
      })
      .catch(() => cache?.rows ?? [])
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function limitsFor(rows: ModelRow[], model: string | null | undefined): ModelLimits {
  if (!model) return DEFAULTS;
  const wanted = slug(model);
  const row = rows.find((r) => r.name && slug(r.name) === wanted);
  if (!row) return DEFAULTS;
  const filetypes =
    Array.isArray(row.allowed_filetypes) && row.allowed_filetypes.length > 0
      ? row.allowed_filetypes
      : DEFAULTS.filetypes;
  return {
    maxRefs: typeof row.max_reference_images === "number" ? row.max_reference_images : DEFAULTS.maxRefs,
    filetypes,
    accept: filetypes.join(","),
    ratios:
      Array.isArray(row.allowed_ratios) && row.allowed_ratios.length > 0
        ? row.allowed_ratios
        : DEFAULTS.ratios,
  };
}

export function useModelLimits(model: string | null | undefined): ModelLimits {
  const [limits, setLimits] = useState<ModelLimits>(() => (cache ? limitsFor(cache.rows, model) : DEFAULTS));
  useEffect(() => {
    let dead = false;
    loadModels().then((rows) => { if (!dead) setLimits(limitsFor(rows, model)); });
    return () => { dead = true; };
  }, [model]);
  return limits;
}

/**
 * The generator catalogue, as the database describes it.
 *
 * Shares the module-level cache above, so a page that already asked for limits
 * pays nothing for this. The node editor used to carry its own hardcoded
 * NC_MODELS with invented prices and a "Seedance 2" that exists in no table —
 * which is how a user could pick a model, see a price, and get something else
 * for free.
 */
export interface CatalogueEntry {
  id: string;
  name: string;
  /** USD per image. 0 is the free tier. */
  price: number;
  /**
   * Which medium the model produces — the generator filter's tree groups by
   * it (models.media_type; rows without the column yet are image models).
   */
  mediaType: "image" | "video";
  /**
   * Whether the model takes a low|medium|high quality tier of its own. Only
   * the gpt-image family does — offering the control anywhere else would put a
   * setting in front of the user that changes nothing.
   */
  supportsQuality: boolean;
  /**
   * The largest resolution tier this model genuinely renders, resolved
   * SERVER-SIDE from its provider route — the same answer the generation
   * enforces. The pickers used to hardcode their tier lists instead, which is
   * how "2K/4K" appeared for models that cannot do either (Kev, 2026-08-19:
   * "das soll doch eher derived from the database sein").
   */
  maxResolution: "1K" | "2K" | "4K";
  /**
   * Aspect ratios this model accepts, from the models table's allowed_ratios
   * column. Live values (probed 2026-08-22): the paid models carry all ten
   * their APIs take, the free Flux row five. The pickers used to hold their
   * own literals — three surfaces, three different lists, none of them the
   * API's (Kev: "derive all these ratio und auflösungseinstellungen from the
   * database!").
   */
  ratios: string[];
  /** Whether a faster host exists for this model — server-derived (hasBoost). */
  boostAvailable?: boolean;
  /** How many reference images the model takes (models.max_reference_images). */
  maxRefs?: number;
  /** Renders on the free host (server-derived). The only thing that makes a generation free. */
  free: boolean;
}

/**
 * Find a catalogue entry by whatever id a draft is carrying.
 *
 * Drafts and the editor's initial state store the model as a SLUG
 * ("nano-banana-pro"), while the live models table keys rows by UUID. Every
 * lookup that compared `m.id === stored` therefore missed for any draft that
 * never re-picked its model: the doc select rendered the raw slug, the gpt
 * lever never appeared, and the cost line showed $0.00 for the default model
 * (Kev's screenshot, 2026-08-19). Matching falls back to the name's family
 * slug, which is exactly what those stored slugs are.
 */

export function resolveCatalogueEntry(
  catalogue: CatalogueEntry[],
  idOrSlug: string | undefined,
): CatalogueEntry | undefined {
  if (!idOrSlug) return undefined;
  /* Two slug dialects exist in the wild and a draft may carry either:
     toModelFamily strips parentheticals ("Flux (free)" -> "flux"), while the
     BY_SLUG bridge in lib/generation/models.ts keeps them ("flux-free").
     Found by this function's own test asserting "flux-free" and failing. */
  const plainSlug = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const exact = catalogue.find((m) => m.id === idOrSlug);
  if (exact) return exact;
  // A slug resolves only when exactly one row answers to it: with two, the
  // cheaper one would win by list order, and that is not what was selected.
  const bySlug = catalogue.filter(
    (m) => toModelFamily(m.name) === idOrSlug || plainSlug(m.name) === idOrSlug,
  );
  return bySlug.length === 1 ? bySlug[0] : undefined;
}

/**
 * The list before /api/models answers. Deliberately EMPTY, not a single
 * hardcoded model: a one-entry fallback made the picker claim "Nano Banana
 * Pro is the only model" whenever the real list had not loaded (Kev,
 * 2026-08-19). An empty catalogue renders as "loading…" and cannot be
 * mistaken for the truth; the real three arrive a beat later and, now that a
 * failed fetch is no longer cached, they arrive reliably.
 */
export const FALLBACK_CATALOGUE: CatalogueEntry[] = [];

export function useModelCatalogue(): CatalogueEntry[] {
  const [rows, setRows] = useState<CatalogueEntry[]>(() =>
    cache ? toCatalogue(cache.rows) : FALLBACK_CATALOGUE,
  );
  useEffect(() => {
    let dead = false;
    /* An EMPTY answer never replaces what is on screen: a 401 during the
       gate-cookie window used to overwrite the fallback catalogue with [],
       which is the empty Generators panel Kev hit (2026-08-24). The retry
       on the next mount fills in the real rows. */
    const pull = () => loadModels().then((r) => { if (!dead && r.length > 0) setRows(toCatalogue(r)); });
    pull();
    /* If the first pull landed before the gate cookie (empty → fallback), a
       later focus refetches, so the list fills itself in without a reload. */
    const onFocus = () => { if (!cache) pull(); };
    window.addEventListener("focus", onFocus);
    return () => { dead = true; window.removeEventListener("focus", onFocus); };
  }, []);
  return rows;
}

function toCatalogue(rows: ModelRow[]): CatalogueEntry[] {
  const out = rows
    .filter((r) => r.id && r.name)
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      // A missing price is 0 and therefore free — never a guessed number,
      // because a guessed price is one a user might be charged.
      price: typeof r.price === "number" ? r.price : 0,
      mediaType: ((r as { media_type?: unknown }).media_type === "video" ? "video" : "image") as CatalogueEntry["mediaType"],
      /* Server-resolved when present (/api/models runs withCapabilities, the
         same code the generation enforces); the old client-side derivations
         only cover the window where a cached pre-upgrade response is still in
         flight. A name regex and a hardcoded tier list are exactly the
         split-brain that put "2K/4K" in front of models that can do neither. */
      supportsQuality:
        typeof r.supportsQuality === "boolean" ? r.supportsQuality : /gpt.?image/i.test(String(r.name)),
      maxResolution: (r.maxResolution === "1K" || r.maxResolution === "2K" || r.maxResolution === "4K"
        ? r.maxResolution
        : "2K") as CatalogueEntry["maxResolution"],
      ratios: Array.isArray(r.allowed_ratios) && r.allowed_ratios.length > 0 ? r.allowed_ratios : FALLBACK_RATIOS,
      boostAvailable: typeof r.boostAvailable === "boolean" ? r.boostAvailable : undefined,
      maxRefs: typeof r.max_reference_images === "number" ? r.max_reference_images : undefined,
      free: r.free === true,
    }));
  return out;
}
