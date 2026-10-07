/**
 * The shell search's client half, kept free of React so its guards are
 * testable: a failed response read into one sentence, the suggest answer
 * flattened into a keyboard list, and the active row stepped with wrap.
 */

export const SEARCH_DEBOUNCE_MS = 250;
export const SUGGEST_DEBOUNCE_MS = 150;
export const SUGGEST_TITLES = 8;
export const SUGGEST_CREATORS = 4;

export type SearchCreator = { id: string; handle: string; displayName: string; avatarUrl: string | null };

export type SuggestItem =
  | { kind: "title"; id: string; label: string }
  | { kind: "creator"; id: string; label: string; handle: string };

/**
 * The server's own sentence wins ("Search is not migrated yet.", "database
 * unreachable"); only a body without one gets the generic fallback.
 */
export async function failureSentence(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" && body.error ? body.error : `${fallback} (HTTP ${res.status}).`;
}

/** Titles first, then creators, capped at 8 and 4 whatever the server sent. */
export function flattenSuggestions(body: unknown): SuggestItem[] {
  const b = (body && typeof body === "object" ? body : {}) as { titles?: unknown; creators?: unknown };
  const titles = Array.isArray(b.titles) ? b.titles : [];
  const creators = Array.isArray(b.creators) ? b.creators : [];
  const out: SuggestItem[] = [];
  for (const t of titles.slice(0, SUGGEST_TITLES) as { id?: unknown; title?: unknown }[]) {
    if (typeof t?.id === "string" && typeof t.title === "string" && t.title) out.push({ kind: "title", id: t.id, label: t.title });
  }
  for (const c of creators.slice(0, SUGGEST_CREATORS) as Partial<SearchCreator>[]) {
    if (typeof c?.id === "string" && typeof c.handle === "string" && c.handle) {
      out.push({ kind: "creator", id: c.id, label: c.displayName || c.handle, handle: c.handle });
    }
  }
  return out;
}

/**
 * Arrow keys over the list: -1 is the input itself, so Down from the last
 * row returns to the field and Up from the field lands on the last row.
 */
export function stepActive(active: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1;
  const span = length + 1;
  return ((((active + 1 + delta) % span) + span) % span) - 1;
}
