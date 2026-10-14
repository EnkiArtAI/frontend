"use client";

/**
 * A released prompt for its owner to edit (package E2): GET /api/prompt?id=
 * (owner only; anyone else gets the 404 a missing prompt gets), mapped by
 * lib/editor/load-prompt once the catalogue is in, because the generator is
 * stored by name and the editor picks by catalogue id.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import { loadPrompt, notYours, type LoadedPrompt, type ServerPrompt } from "@/lib/editor/load-prompt";
import { sessionAuthHeaders } from "@/lib/session-headers";

export const promptKey = (id: string | null) => ["/api/prompt", id] as const;

export function usePromptLoad(id: string | null, catalogue: CatalogueEntry[]): {
  loaded: LoadedPrompt | null;
  /** Not found, not this account's, or not signed in: the server does not say which. */
  missing: boolean;
  /** Any other refusal, or no answer: worth asking again. */
  failed: boolean;
  retry: () => void;
  loading: boolean;
} {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: promptKey(id),
    enabled: id !== null,
    retry: false,
    staleTime: Infinity,
    queryFn: async (): Promise<ServerPrompt> => {
      const res = await fetch(`/api/prompt?id=${encodeURIComponent(id ?? "")}`, { headers: sessionAuthHeaders() });
      if (!res.ok) throw Object.assign(new Error(`GET /api/prompt ${res.status}`), { status: res.status });
      return res.json();
    },
  });
  const loaded = useMemo(() => (data && catalogue.length ? loadPrompt(data, catalogue) : null), [data, catalogue]);
  const refused = id !== null && !!error && !isFetching;
  const missing = refused && notYours((error as { status?: number }).status);
  return {
    loaded,
    missing,
    failed: refused && !missing,
    retry: () => void refetch(),
    loading: id !== null && !loaded && !refused,
  };
}
