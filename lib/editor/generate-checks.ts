/**
 * Generate in the Prompt Editor: what a job carries, the request it sends,
 * and the checks a click passes first (plan §2.1, R12). The first check that
 * fails says what the surface does (a toast, a focused field, the login, the
 * generator picker, the wallet picker, the add-funds prompt) and no job is
 * made. A render must be one that can be released: the server needs every
 * [slot] stored under a name and filled with the value that made the
 * showcase (app/api/prompt), so a render without that is paid for nothing.
 */
import type { GenerationRequest } from "@/lib/generation/run-generation";
import type { GenerationQuote } from "@/lib/generation-checkout";
import { boostAt, type CatalogueEntry } from "@/hooks/useModelLimits";
import { REFS_LOADING } from "@/hooks/useReferenceReads";
import { tiersUpTo, type ResolutionTier } from "@/lib/generation/resolution";
import { storedName } from "@/lib/generation/stored-name";
import { tooLargeToSend, REFS_TOO_LARGE } from "@/lib/request-size";
import { overBalance } from "@/lib/ui/kit/price";
import { fillPrompt, parseTokens, varNames } from "./prompt-tokens";
import type { EditorDoc, RefStore, VarKind } from "./undo";

export type Quality = "low" | "medium" | "high";

/** The settings row as picked. Each model renders them its own way (renderSettings). */
export interface RenderPicks {
  ratio: string;
  resolution: ResolutionTier;
  quality?: Quality;
  boost: boolean;
}

/** One job's setup: everything to run it again exactly as it was made (create-desktop D7). */
export interface EditorSetup extends RenderPicks {
  /** The editor text at the click. */
  prompt: string;
  /** The values of this text's own variables, nothing else. */
  vars: Record<string, string>;
  kinds: Record<string, VarKind>;
  refIds: string[];
  modelId: string;
  modelName: string;
}

type Content = Pick<EditorDoc, "prompt" | "vars" | "kinds" | "refIds">;

/** The most references a prompt can be saved with (app/api/prompt REFERENCE_IMAGES_MAX). */
const MAX_REFS = 14;

/**
 * The picks as this model renders them, which is also what its price is asked
 * for: ratio and tier inside its lists (useGenerationCore's clamps), quality
 * only where it has one, and boost only where a faster host runs at that tier
 * (BoostToggle) and the model has one at all (runGeneration's own mask).
 */
export function renderSettings(entry: CatalogueEntry, picks: RenderPicks): RenderPicks {
  const tiers = tiersUpTo(entry.maxResolution);
  const resolution = tiers.includes(picks.resolution) ? picks.resolution : tiers[tiers.length - 1];
  return {
    ratio: entry.ratios.includes(picks.ratio) ? picks.ratio : entry.ratios[0],
    resolution,
    quality: entry.supportsQuality ? picks.quality : undefined,
    boost: picks.boost && boostAt(entry, resolution) && entry.boostAvailable === true,
  };
}

export function editorSetup(doc: Content, entry: CatalogueEntry, picks: RenderPicks): EditorSetup {
  const names = varNames(doc.prompt);
  return {
    prompt: doc.prompt,
    vars: Object.fromEntries(names.map((n) => [n, doc.vars[n] ?? ""])),
    kinds: Object.fromEntries(names.map((n) => [n, doc.kinds[n] ?? "text"])),
    refIds: doc.refIds,
    modelId: entry.id,
    modelName: entry.name,
    ...renderSettings(entry, picks),
  };
}

/** The data URLs a render sends for `ids`, or null while any of them is not read in. */
export function readyRefs(refs: RefStore, ids: string[]): string[] | null {
  const data = ids.map((id) => (refs[id]?.state === "ready" ? refs[id].data : null));
  return data.every((d): d is string => !!d) ? data : null;
}

/**
 * The request of a test render: the artist's own draft (`authoring`), never a
 * promptId, which would price an artist share and render the stored text
 * instead (lib/generation-checkout QuoteRequest).
 */
export function editorRequest(setup: EditorSetup, catalogue: CatalogueEntry[], refData: string[]): GenerationRequest {
  return {
    model: catalogue.find((m) => m.id === setup.modelId),
    resolution: setup.resolution,
    quality: setup.quality,
    boost: setup.boost,
    prompt: fillPrompt(setup.prompt, setup.vars),
    aspectRatio: setup.ratio,
    referenceImages: refData.length ? refData : undefined,
    authoring: true,
  };
}

/** The first variable the save could not store: unnamed, with nothing to slug, or under another one's stored name (R19). */
export function nameIssue(names: string[]): { name: string; message: string } | null {
  const seen = new Map<string, string>();
  for (const name of names) {
    if (!name) return { name, message: "Name every variable first" };
    const stored = storedName(name);
    if (stored === null) return { name, message: `[${name}] needs a letter a–z or a digit to be saved` };
    const other = seen.get(stored);
    if (other !== undefined) return { name, message: `[${other}] and [${name}] would be saved under one name · rename one` };
    seen.set(stored, name);
  }
  return null;
}

/** The first name whose value is blank. */
export const emptyValue = (names: string[], vars: Record<string, string>) => names.find((n) => !(vars[n] ?? "").trim());

export type GenerateCheck =
  | "prompt" | "login" | "generator" | "names" | "values" | "refs-ready" | "refs-missing"
  | "refs-free" | "refs-max" | "price" | "wallet" | "funds" | "size";

export interface GenerateBlock {
  check: GenerateCheck;
  /** The sentence to show (toast and cost line). */
  toast?: string;
  focus?: { variable: string };
  open?: "login" | "primary" | "wallet" | "add-funds";
}

export interface GenerateInput {
  /** The editor's doc; for Regenerate and Retry, the job's setup. */
  doc: Content;
  refs: RefStore;
  /** Files still being read in (useReferenceReads().loading). */
  reading: boolean;
  signedIn: boolean;
  /** The test generator; undefined when none is picked. */
  entry: CatalogueEntry | undefined;
  picks: RenderPicks;
  /** The server's price for exactly this render; null until it answers. */
  quote: GenerationQuote | null;
  /** A wallet that can sign is connected. */
  wallet: boolean;
  /** The payer's balance; null when unknown (no Solana payer, not loaded), which is not checked. */
  balanceUsd: number | null;
  /** The user chose "Try anyway" on the low-balance prompt (R29). */
  lowBalanceOk?: boolean;
}

/** The first of the thirteen checks that fails, in the plan's order; null when Generate may run. */
export function generateBlock(i: GenerateInput): GenerateBlock | null {
  const { doc, entry } = i;
  if (!doc.prompt.trim()) return { check: "prompt", toast: "Write a prompt first" };
  if (!i.signedIn) return { check: "login", open: "login" };
  if (!entry) return { check: "generator", toast: "Pick a generator", open: "primary" };
  const names = varNames(doc.prompt);
  const bad = nameIssue(names);
  if (bad) return { check: "names", toast: bad.message, focus: { variable: bad.name } };
  const empty = emptyValue(names, doc.vars);
  if (empty !== undefined) return { check: "values", toast: `Fill in [${empty}] first`, focus: { variable: empty } };
  const states = doc.refIds.map((id) => i.refs[id]?.state);
  if (states.some((s) => s !== "ready" && s !== "loading")) {
    return { check: "refs-ready", toast: "A reference image couldn't be loaded · upload it again" };
  }
  if (i.reading || states.includes("loading")) return { check: "refs-ready", toast: REFS_LOADING };
  const count = doc.refIds.length;
  const missing = parseTokens(doc.prompt).find((t) => t.kind === "ref" && (t.n < 1 || t.n > count));
  if (missing) return { check: "refs-missing", toast: `[${missing.name}] has no image · upload it or remove the token` };
  if (count && entry.free) return { check: "refs-free", toast: `${entry.name} takes no reference images · pick another generator or remove them` };
  const max = Math.min(MAX_REFS, entry.maxRefs ?? MAX_REFS);
  if (count > max) return { check: "refs-max", toast: `${entry.name} takes up to ${max} reference images` };
  if (!entry.free) {
    if (!i.quote) return { check: "price", toast: "Getting the price…" };
    if (!i.wallet) return { check: "wallet", open: "wallet" };
    if (i.balanceUsd !== null && !i.lowBalanceOk && overBalance(i.balanceUsd, i.quote.totalMicro)) {
      return { check: "funds", open: "add-funds" };
    }
  }
  const request = editorRequest(editorSetup(doc, entry, i.picks), [entry], readyRefs(i.refs, doc.refIds) ?? []);
  if (tooLargeToSend(request)) return { check: "size", toast: REFS_TOO_LARGE };
  return null;
}
