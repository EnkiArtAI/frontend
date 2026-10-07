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

/* A paid prompt is the artist's product, and tags are public: whoever
   collects them across a creator's prompts would read the recipe back out of
   them. So a paid body yields only WHAT it shows, a few subjects, never HOW:
   no style, medium, mood, colour, framing or technique (Kev, 2026-10-07:
   search must keep the prompt private and make distilling it impossible).
   Title and variables are public on the prompt page anyway and keep the full
   vocabulary. */
export const PAID_SUBJECT_CAP = 5;

export const TAG_CAP = 40;

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

/**
 * Canonical vocabulary tags found in the text, in order of first appearance.
 * The longest term at each position wins and owns its words: "god rays" is
 * a lighting term, never also the subject "god", and "unreal engine" never
 * leaves an "engine" behind. A paid body keeps its first few subjects only.
 */
export function extractTags(text: string, options: { paid: boolean } = { paid: false }): string[] {
  const stems = tokens(text).map(stem);
  const found = new Set<string>();
  for (let i = 0; i < stems.length; ) {
    let n = Math.min(LONGEST, stems.length - i);
    let entry: Entry | undefined;
    for (; n > 0; n--) if ((entry = INDEX.get(stems.slice(i, i + n).join(" ")))) break;
    if (!entry) { i++; continue; }
    i += n;
    if (!options.paid || entry.category === "subject") found.add(entry.tag);
  }
  const tags = [...found];
  return options.paid ? tags.slice(0, PAID_SUBJECT_CAP) : tags;
}

/** What prompts.tags stores: every group's tags, deduplicated, capped, and
    sorted so the order says nothing about where in the prompt a word stood. */
export function storedTags(...groups: string[][]): string[] {
  const all = new Set(groups.flat().map((t) => t.trim().toLowerCase()).filter(Boolean));
  return [...all].sort().slice(0, TAG_CAP);
}
