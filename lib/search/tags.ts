import vocabulary from "./vocabulary.json";
import { stem } from "./stem";

/*
 * Vocabulary matching for search (Kev, 2026-09-24: "das muss dann kostenlos
 * sein"). No model, no paid API: a curated vocabulary of canonical tags with
 * synonyms, matched against the prompt text by stemmed n-grams, entirely in
 * this process. Runs inside the publish request on the plaintext the client
 * sent, before the body is encrypted, so only the canonical tags ever reach
 * prompts.tags and the search index. The prompt body itself is never stored
 * or indexed in the clear.
 */

export type VocabularyCategory =
  | "subject" | "style" | "medium" | "mood" | "color" | "composition" | "technique";

type Entry = { tag: string; category: VocabularyCategory; synonyms: string[] };

/* A paid prompt is the artist's product: which colours, framing and
   rendering tricks make it work is what the buyer pays for, so only the
   broad categories of a paid prompt are searchable. */
const PAID_CATEGORIES: ReadonlySet<VocabularyCategory> = new Set(["subject", "style", "medium", "mood"]);

export const TAG_CAP = 60;

const ENTRIES = vocabulary as Entry[];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/\[[^\]\n]*\]/g, " ")
    .replace(/\(([^()]*):\s*\d+(?:\.\d+)?\)/g, "$1")
    .replace(/'/g, "")
    .split(/[^a-z0-9&]+/)
    .filter(Boolean);
}

const key = (phrase: string) => tokens(phrase).map(stem).join(" ");

/* Stemmed phrase -> entry. Tags are indexed before synonyms so a tag always
   beats another entry's synonym; the test suite proves the vocabulary has no
   stem collision between different tags at all. */
const INDEX = new Map<string, Entry>();
let LONGEST = 1;
function index(phrase: string, entry: Entry) {
  const k = key(phrase);
  if (!INDEX.has(k)) INDEX.set(k, entry);
  LONGEST = Math.max(LONGEST, k.split(" ").length);
}
for (const entry of ENTRIES) index(entry.tag, entry);
for (const entry of ENTRIES) for (const synonym of entry.synonyms) index(synonym, entry);

export function stemmedKey(phrase: string): string {
  return key(phrase);
}

/** Canonical vocabulary tags found in the text, in order of first appearance. */
export function extractTags(text: string, options: { paid: boolean } = { paid: false }): string[] {
  const stems = tokens(text).map(stem);
  const found = new Set<string>();
  for (let i = 0; i < stems.length; i++) {
    for (let n = 1; n <= LONGEST && i + n <= stems.length; n++) {
      const entry = INDEX.get(stems.slice(i, i + n).join(" "));
      if (entry && (!options.paid || PAID_CATEGORIES.has(entry.category))) found.add(entry.tag);
    }
  }
  return [...found];
}

/** The creator's own tags first, then the extracted ones, deduplicated and capped. */
export function mergeTags(existingCreatorTags: string[], extracted: string[]): string[] {
  const merged = new Set<string>();
  for (const t of [...existingCreatorTags, ...extracted]) {
    const tag = t.trim().toLowerCase();
    if (tag) merged.add(tag);
  }
  return [...merged].slice(0, TAG_CAP);
}
