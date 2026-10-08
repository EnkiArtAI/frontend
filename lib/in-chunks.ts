/**
 * An .in() lookup over many ids, a slice at a time. PostgREST carries the ids
 * in the URL, and a few hundred uuids make a URL the gateway refuses, which
 * supabase-js hands back as an error: every lookup then reads as empty.
 */
export const IN_CHUNK = 150;

export async function inChunks<T>(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const unique = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) out.push(...((await read(unique.slice(i, i + IN_CHUNK))).data ?? []));
  return out;
}
