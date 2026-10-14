/**
 * A released prompt back in the Prompt Editor (package E2): the answer of
 * GET /api/prompt?id= as the editor's doc, references, listing and settings,
 * plus the prompt exactly as stored, which a listing-only update sends back.
 *
 * The server keeps a slot's variable under its slug ("red car" → red_car) and
 * a reference as plain "Reference image n". So the text is read back with
 * fromServerText (only for the references that exist), and each [slot] finds
 * its variable by name, then by storedName, then by label.
 */
import { resolveCatalogueEntry, type CatalogueEntry } from "@/hooks/useModelLimits";
import { ENKI_CATEGORIES } from "@/lib/categories";
import { normalizeTier } from "@/lib/generation/resolution";
import { storedName } from "@/lib/generation/stored-name";
import { DEFAULT_PROMPT_PRICE_USD } from "@/shared/revenue-config";
import { fromServerText, varNames } from "./prompt-tokens";
import type { RenderPicks } from "./generate-checks";
import type { Listing, Saved, SavedVariable } from "./release";
import type { EditorDoc, RefStore, VarKind } from "./undo";

/** A variable as GET /api/prompt answers it. */
export interface ServerVariable {
  name: string;
  label: string;
  description: string;
  type: string;
  defaultValue: unknown;
  required: boolean;
  position: number;
  min: number | null;
  max: number | null;
  options: unknown;
}

/** GET /api/prompt?id= (owner only), the fields the editor reads. */
export interface ServerPrompt {
  id: string;
  title: string;
  content: string;
  category: string;
  aiModel: string | null;
  /** The generators on offer, by name (ai_settings.models); absent or empty before the multi-select. */
  aiModels?: string[];
  price: number;
  aspectRatio: string | null;
  promptType: string;
  uploadedPhotos: string[];
  referenceImages: string[];
  resolution: string | null;
  variables: ServerVariable[];
}

export interface LoadedPrompt {
  id: string;
  doc: EditorDoc;
  /** Keyed by the stored URL; each must be read into a data URL before a render can send it. */
  refs: RefStore;
  listing: Listing;
  /** The ratio and resolution the prompt was saved with, where it has them. */
  picks: Partial<Pick<RenderPicks, "ratio" | "resolution">>;
  saved: Saved;
}

/**
 * GET /api/prompt?id= answers a bad id (400), no session (401), or a prompt
 * that is missing or another account's (404): none of these opens when asked
 * again (create-desktop §3.13). Anything else, a 5xx or no answer, may.
 */
export const notYours = (status: number | undefined) => status === 400 || status === 401 || status === 404;

/** The variable behind a [slot]. */
export function slotVariable(slot: string, variables: ServerVariable[]): ServerVariable | undefined {
  const stored = storedName(slot);
  return (
    variables.find((v) => v.name === slot) ??
    variables.find((v) => v.name === stored) ??
    variables.find((v) => v.label === slot)
  );
}

export function loadPrompt(p: ServerPrompt, catalogue: CatalogueEntry[]): LoadedPrompt {
  const prompt = fromServerText(p.content, p.referenceImages.length);
  const slots = varNames(prompt).map((slot) => ({ slot, v: slotVariable(slot, p.variables) }));
  const kinds: Record<string, VarKind> = {};
  const vars: Record<string, string> = {};
  for (const { slot, v } of slots) {
    // A checkbox shows its description and adds its label; its text is either.
    kinds[slot] = v?.type === "checkbox" ? "checkbox" : "text";
    vars[slot] = v?.type === "checkbox" ? v.description || v.label : String(v?.defaultValue ?? "");
  }
  const premium = p.promptType === "paid-prompt";
  const entry = (name: string | null | undefined) => (name ? (catalogue.find((m) => m.name === name) ?? resolveCatalogueEntry(catalogue, name)) : undefined);
  // The offered generators (the prompt's own model among them, for a prompt from before the list); a name the catalogue no longer has is dropped.
  const modelIds = [...new Set([entry(p.aiModel), ...(p.aiModels ?? []).map(entry)].flatMap((m) => (m ? [m.id] : [])))];
  const resolution = normalizeTier(p.resolution);
  // Sent back under the slot's own text, which the save matches its slots by.
  const variables = p.variables.map((v): SavedVariable => ({
    name: slots.find((s) => s.v === v)?.slot ?? v.name,
    label: v.label,
    description: v.description,
    type: v.type,
    defaultValue: v.defaultValue,
    required: v.required,
    position: v.position,
    options: v.options,
    min: v.min,
    max: v.max,
  }));
  return {
    id: p.id,
    doc: { prompt, vars, kinds, aiNames: [], refIds: p.referenceImages },
    refs: Object.fromEntries(p.referenceImages.map((url) => [url, { data: null, stored: url, state: "loading" }])),
    listing: {
      title: p.title,
      mode: premium ? "premium" : "free",
      price: premium ? p.price : DEFAULT_PROMPT_PRICE_USD,
      category: (ENKI_CATEGORIES as readonly string[]).includes(p.category) ? p.category : null,
      modelIds,
      testId: null,
    },
    picks: { ...(p.aspectRatio ? { ratio: p.aspectRatio } : {}), ...(resolution ? { resolution } : {}) },
    saved: {
      content: p.content,
      variables,
      referenceImages: p.referenceImages,
      uploadedPhotos: p.uploadedPhotos,
      aspectRatio: p.aspectRatio,
      resolution: p.resolution,
      aiModel: p.aiModel,
    },
  };
}
