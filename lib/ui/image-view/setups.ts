/**
 * The Image View's job (the `S` of the render queue's Job<S>, plan §1.3):
 * everything one Generate sent, so the queue can retry it, Regenerate can run
 * it again and load it back into the composer, and the viewer can list its
 * values. A job is built once, in the click handler; the same build in render
 * prices exactly what Generate would send.
 */
import { boostAt, type CatalogueEntry } from "@/hooks/useModelLimits";
import type { ComposerQuoteRequest } from "@/hooks/useComposerQuote";
import type { GenerationRequest } from "@/lib/generation/run-generation";
import { buildGenerationPrompt } from "./assemble";
import { parseSegments, type PromptVariable } from "./segments";
import { fieldsFor, toServerValues, valueRows, type ValueRow } from "./variables";

type Resolution = GenerationRequest["resolution"];
type Quality = NonNullable<GenerationRequest["quality"]>;

export interface ImageSetup {
  /** The prompt rendered from; absent in the blank composer. */
  promptId?: string;
  model: CatalogueEntry;
  resolution: Resolution;
  aspectRatio: string;
  /** Only where the model has the lever. */
  quality?: Quality;
  /** Only where a faster host exists at this size. */
  boost: boolean;
  /** Exactly the text sent. */
  prompt: string;
  /** A prompt's values as the server fills its text with them, by stored name; absent in the blank composer. */
  variableValues?: Record<string, string>;
  /** The composer's values as they were, for Regenerate to load back. */
  values: Record<string, string>;
  /** The buyer's own wording, or null for the artist's. */
  edited: string | null;
  /** Data URLs, in order ("Reference image n" is the n-th). */
  refs: string[];
  /** The fields with the values sent, for the viewer's list. */
  rows: ValueRow[];
}

/** The composer as it stands. The ratio and resolution are already clamped to the model (useGenerationCore). */
export interface Composer {
  /** Absent in the blank composer. */
  promptId?: string;
  title?: string;
  /** The artist's text: a free prompt's, "" in the blank composer, null on a premium prompt (its text never reaches the client). */
  publicText: string | null;
  edited: string | null;
  variables: PromptVariable[];
  values: Record<string, string>;
  model: CatalogueEntry | undefined;
  resolution: Resolution;
  aspectRatio: string;
  quality: Quality;
  boost: boolean;
  refs: string[];
}

/** The job Generate would run now; null while no generator is chosen. Quality and Boost are kept only where they change the render. */
export function makeSetup(c: Composer): ImageSetup | null {
  const { model } = c;
  if (!model) return null;
  const text = c.edited ?? c.publicText;
  return {
    ...(c.promptId ? { promptId: c.promptId, variableValues: toServerValues(c.variables, c.values) } : {}),
    model,
    resolution: c.resolution,
    aspectRatio: c.aspectRatio,
    ...(model.supportsQuality ? { quality: c.quality } : {}),
    boost: c.boost && boostAt(model, c.resolution),
    prompt: buildGenerationPrompt({ title: c.title, text, variables: c.variables, values: c.values }),
    values: { ...c.values },
    edited: c.edited,
    refs: [...c.refs],
    rows: valueRows(fieldsFor(c.variables, text === null ? null : parseSegments(text, c.variables)), c.values),
  };
}

/** The request runGeneration sends for this job, the same each time it runs. The blank composer's carries no prompt and no values. */
export function toRequest(s: ImageSetup): GenerationRequest {
  return {
    model: s.model,
    resolution: s.resolution,
    quality: s.quality,
    boost: s.boost,
    prompt: s.prompt,
    ...(s.promptId ? { promptId: s.promptId, variableValues: s.variableValues } : {}),
    aspectRatio: s.aspectRatio,
    ...(s.refs.length ? { referenceImages: s.refs } : {}),
  };
}

/** What the chip prices for this job (useComposerQuote): its settings, each reference counted, as each is checked and charged. */
export const quoteOf = (s: ImageSetup): ComposerQuoteRequest => ({
  promptId: s.promptId,
  entry: s.model,
  resolution: s.resolution,
  quality: s.quality,
  boost: s.boost,
  referenceImageCount: s.refs.length,
});
