/**
 * The Verify column (handoff §4): renders grouped into variations and
 * stacks, and the stars a release is made of.
 *
 * A variation is one prompt text: the same text has the same variables and
 * the same reference tokens, so changing only values keeps the variation.
 * Its letter and colour come from when it first appeared and never change
 * (the prototype coloured by list position, so each new variation recoloured
 * the others). Inside a variation, renders with the same values are a stack.
 * Variations and stacks are newest first; a render added to an old stack
 * moves nothing, and the newest render is on top.
 */
import type { Job } from "@/lib/ui/kit/render-queue";
import { varNames } from "./prompt-tokens";
import type { EditorSetup } from "./generate-checks";

type EditorJob = Job<EditorSetup>;

export const variationKey = (s: Pick<EditorSetup, "prompt">) => s.prompt.trim();

export const valuesKey = (s: Pick<EditorSetup, "prompt" | "vars">) =>
  JSON.stringify(varNames(s.prompt).map((n) => s.vars[n] ?? ""));

/** A … Z, AA, AB …: the letter of the i-th variation ever made, from 0. */
export function letterAt(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** The colour of the i-th variation: the --enki-vary-1…6 tokens in turn. */
export const varyColor = (i: number) => `var(--enki-vary-${(i % 6) + 1})`;

/**
 * The variation keys in the order they first appeared, with `key` added once.
 * The editor keeps this list with its draft, so a variation keeps its letter
 * when its renders are dropped or retried.
 */
export const withVariation = (order: string[], key: string) => (order.includes(key) ? order : [...order, key]);

export interface Stack {
  key: string;
  /** Newest first. */
  jobs: EditorJob[];
}

export interface Variation {
  key: string;
  letter: string;
  color: string;
  names: string[];
  /** Newest first, every status. */
  jobs: EditorJob[];
  stacks: Stack[];
}

/** The variations, newest first. Keys `order` does not hold yet follow it, by their first render. */
export function variations(jobs: EditorJob[], order: string[]): Variation[] {
  const byAge = [...jobs].sort((a, b) => a.createdAt - b.createdAt);
  const known = byAge.reduce((o, j) => withVariation(o, variationKey(j.setup)), order);
  return known
    .flatMap((key, i) => {
      const own = byAge.filter((j) => variationKey(j.setup) === key).reverse();
      return own.length
        ? [{ key, letter: letterAt(i), color: varyColor(i), names: varNames(own[0].setup.prompt), jobs: own, stacks: stacksOf(own) }]
        : [];
    })
    .reverse();
}

/** `own` newest first → stacks newest first by when each began. */
function stacksOf(own: EditorJob[]): Stack[] {
  const stacks = new Map<string, EditorJob[]>();
  for (const j of [...own].reverse()) {
    const key = valuesKey(j.setup);
    stacks.set(key, [j, ...(stacks.get(key) ?? [])]);
  }
  return [...stacks].map(([key, jobs]) => ({ key, jobs })).reverse();
}

/** What the full-screen preview pages through: ready renders, newest variation first, newest first within it. */
export const previewList = (groups: Variation[]) => groups.flatMap((g) => g.jobs.filter((j) => j.status === "ready"));

/** How a sibling in the same variation differs: "≠ mood", "≠ 2 vars", or "" for the same values. */
export function siblingTag(a: Pick<EditorSetup, "prompt" | "vars">, b: Pick<EditorSetup, "vars">): string {
  const diff = varNames(a.prompt).filter((n) => (a.vars[n] ?? "") !== (b.vars[n] ?? ""));
  return diff.length === 0 ? "" : diff.length === 1 ? `≠ ${diff[0]}` : `≠ ${diff.length} vars`;
}

/** jobId → when it was starred. An editor map, not a queue field (plan §1.3); the first star is the cover. */
export type Stars = Record<string, number>;

/** Stars a release takes: 1 for Free, 4 for Premium. */
export const needFor = (mode: "free" | "premium") => (mode === "free" ? 1 : 4);

/**
 * Only a stored render can be a showcase image: the server takes the
 * creator's own recorded https renders (app/api/prompt), and a data: render
 * was never recorded.
 */
export const canStar = (j: EditorJob) => j.status === "ready" && j.imageUrl?.startsWith("https://") === true;

/** The starred jobs that still exist, in star order. */
export const starred = (stars: Stars, jobs: EditorJob[]) =>
  jobs.filter((j) => stars[j.id] !== undefined).sort((a, b) => stars[a.id] - stars[b.id]);

/**
 * Star or unstar `id`. All stars come from one variation: a star elsewhere
 * clears the others and says so. Free takes one (the star moves); Premium
 * takes four and refuses a fifth. Unstarring always works.
 */
export function toggleStar(stars: Stars, jobs: EditorJob[], id: string, need: number, now: number): { stars: Stars; toast?: string } {
  const job = jobs.find((j) => j.id === id);
  if (!job) return { stars };
  if (stars[id] !== undefined) return { stars: Object.fromEntries(Object.entries(stars).filter(([k]) => k !== id)) };
  if (!canStar(job)) return { stars, toast: "This render wasn't stored, so it can't be a showcase image" };
  const current = starred(stars, jobs);
  if (current.some((j) => variationKey(j.setup) !== variationKey(job.setup))) {
    return { stars: { [id]: now }, toast: need === 1 ? "Star moved to this variation" : `Stars moved to this variation — all ${need} must come from one` };
  }
  if (need === 1) return { stars: { [id]: now } };
  if (current.length >= need) return { stars, toast: `A release takes exactly ${need} — unstar one first` };
  return { stars: { ...stars, [id]: now } };
}

/** Premium → Free: one star stays, the earliest. */
export function starsForFree(stars: Stars, jobs: EditorJob[]): { stars: Stars; toast?: string } {
  const [first, ...rest] = starred(stars, jobs);
  return rest.length ? { stars: { [first.id]: stars[first.id] }, toast: "Free releases with 1 image — kept your first star" } : { stars };
}
