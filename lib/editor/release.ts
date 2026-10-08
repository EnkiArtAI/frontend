/**
 * Release (plan R13; create-desktop §3.11–3.12): why a release cannot go
 * yet, and the POST /api/prompt body it sends with `release: true`.
 *
 * The body is made from the FIRST starred render, never from what the editor
 * shows now (create-desktop D5): the server needs every [slot]'s default to
 * be the value that made the showcase (app/api/prompt, Kev 2026-08-24), so
 * the text, values, references, ratio and resolution all come from that
 * render. After the first release the editor stays on /editor?id=, and the
 * next release sends the same body with that id, which updates the prompt.
 */
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { Job } from "@/lib/ui/kit/render-queue";
import { SAVE_TOO_LARGE, tooLargeToSend } from "@/lib/request-size";
import { toServerText, varNames } from "./prompt-tokens";
import { emptyValue, nameIssue, type EditorSetup } from "./generate-checks";
import { needFor } from "./variations";
import type { EditorDoc, RefStore } from "./undo";

export interface Listing {
  title: string;
  mode: "free" | "premium";
  /** Dollars per render, whole cents; what Premium charges on top of the generator. */
  price: number;
  /** One of ENKI_CATEGORIES; null until picked. */
  category: string | null;
  /** The catalogue id of the generator the prompt is made for; null until picked. */
  primaryId: string | null;
  /** The catalogue id of the test generator; null follows the primary. */
  testId: string | null;
}

/** A variable as app/api/prompt takes it (its VariablePayload). */
export interface SavedVariable {
  name: string;
  label: string;
  description: string;
  type: string;
  defaultValue: unknown;
  required: boolean;
  position: number;
  options?: unknown;
  min?: number | null;
  max?: number | null;
}

/** What a released prompt holds on the server, as a listing-only update sends it back (lib/editor/load-prompt). */
export interface Saved {
  content: string;
  variables: SavedVariable[];
  referenceImages: string[];
  uploadedPhotos: string[];
  aspectRatio: string | null;
  resolution: string | null;
}

/** POST /api/prompt (its SaveBody), field for field. */
export interface ReleaseBody extends Saved {
  release: true;
  /** The prompt to update; absent for the first release. */
  id?: string;
  title: string;
  promptType: "free-prompt" | "premium-prompt";
  aiModel: string;
  category: string;
  /** Dollars; 0 for Free. */
  price: number;
}

export type ReleaseCheck = "stars" | "primary" | "model" | "title" | "category" | "price" | "names" | "values" | "busy";

export interface ReleaseBlock {
  check: ReleaseCheck;
  /** The sentence to toast; null when the click is ignored (a release is on its way). */
  message: string | null;
  focus?: "title" | "price" | { variable: string };
  open?: "primary" | "category";
}

/**
 * The first reason Release cannot go, in order; null when it may. With
 * `loaded` (a listing-only update) the loaded doc stands in for the starred
 * renders.
 */
export function releaseBlock({ listing, primary, starred, loaded, busy }: {
  listing: Listing;
  primary: CatalogueEntry | undefined;
  /** In star order. */
  starred: Job<EditorSetup>[];
  loaded?: Pick<EditorDoc, "prompt" | "vars"> | null;
  busy: boolean;
}): ReleaseBlock | null {
  const short = needFor(listing.mode) - starred.length;
  if (!loaded && short > 0) return { check: "stars", message: `Star ${short} more image${short === 1 ? "" : "s"} from one variation` };
  if (!primary) return { check: "primary", message: "Pick the generator this prompt is made for", open: "primary" };
  const other = starred.filter((j) => j.setup.modelId !== primary.id);
  if (other.length) {
    const model = other[0].setup.modelName;
    return {
      check: "model",
      message: `${other.length} starred image${other.length === 1 ? " was" : "s were"} made with ${model} — your primary generator is ${primary.name}. Star images from ${primary.name}, or make ${model} primary`,
    };
  }
  if (!listing.title.trim()) return { check: "title", message: "Give your prompt a title", focus: "title" };
  if (!listing.category) return { check: "category", message: "Pick a category", open: "category" };
  // The server stores whole cents and sells nothing under one.
  if (listing.mode === "premium" && Math.round(listing.price * 100) < 1) {
    return { check: "price", message: "Set a price of at least $0.01", focus: "price" };
  }
  const from = loaded ?? starred[0].setup;
  const names = varNames(from.prompt);
  const bad = nameIssue(names);
  if (bad) return { check: "names", message: bad.message, focus: { variable: bad.name } };
  const empty = emptyValue(names, from.vars);
  if (empty !== undefined) return { check: "values", message: `Every variable needs a value — [${empty}] is empty`, focus: { variable: empty } };
  if (busy) return { check: "busy", message: null };
  return null;
}

const listingFields = (listing: Listing, primary: CatalogueEntry) => ({
  title: listing.title.trim(),
  promptType: listing.mode === "premium" ? ("premium-prompt" as const) : ("free-prompt" as const),
  // The buyer page and the feed's generator filter read the model by name.
  aiModel: primary.name,
  category: listing.category ?? "",
  price: listing.mode === "premium" ? listing.price : 0,
});

/**
 * A checkbox is shown to buyers by its description and adds its label when
 * ticked, so both carry its text; the showcase was made with it ticked.
 */
function variable(name: string, s: EditorSetup, position: number): SavedVariable {
  const value = s.vars[name] ?? "";
  return s.kinds[name] === "checkbox"
    ? { name, label: value, description: value, type: "checkbox", defaultValue: true, required: false, position }
    : { name, label: name, description: "", type: "text", defaultValue: value, required: true, position };
}

/** The release from the starred renders (in star order), once releaseBlock lets it go. */
export function releaseBody({ listing, primary, starred, refs, id }: {
  listing: Listing;
  primary: CatalogueEntry;
  starred: Job<EditorSetup>[];
  refs: RefStore;
  id?: string;
}): { body: ReleaseBody } | { error: string } {
  const cover = starred[0].setup;
  // A loaded reference goes back as the stored URL the server keeps; a new one as its data.
  const referenceImages = cover.refIds.map((r) => refs[r]?.stored ?? refs[r]?.data);
  if (!referenceImages.every((u): u is string => !!u)) {
    return { error: "A reference image of the starred render is gone · upload it again and render once more" };
  }
  const body: ReleaseBody = {
    release: true,
    id,
    ...listingFields(listing, primary),
    content: toServerText(cover.prompt),
    variables: varNames(cover.prompt).map((name, position) => variable(name, cover, position)),
    referenceImages,
    uploadedPhotos: starred
      .map((j) => j.imageUrl ?? "")
      .filter((u) => u.startsWith("https://"))
      .slice(0, needFor(listing.mode)),
    aspectRatio: cover.ratio,
    resolution: cover.resolution,
  };
  return tooLargeToSend(body) ? { error: SAVE_TOO_LARGE } : { body };
}

/** A loaded prompt untouched in text, values and references, with nothing starred: Release only updates its listing. */
export function listingOnly(doc: EditorDoc, loaded: EditorDoc, starredCount: number): boolean {
  const print = (d: EditorDoc) => {
    const names = varNames(d.prompt);
    return JSON.stringify([d.prompt, names.map((n) => d.vars[n] ?? ""), names.map((n) => d.kinds[n] ?? "text"), d.refIds]);
  };
  return starredCount === 0 && print(doc) === print(loaded);
}

/** The listing-only update: the new listing over the prompt exactly as it was loaded (create-desktop §3.11). */
export function updateBody({ listing, primary, saved, id }: {
  listing: Listing;
  primary: CatalogueEntry;
  saved: Saved;
  id: string;
}): ReleaseBody {
  return { release: true, id, ...listingFields(listing, primary), ...saved };
}
