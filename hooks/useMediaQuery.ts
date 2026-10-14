"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Whether `query` matches (lib/ui/kit/breakpoints). False on the server and
 *  during hydration, then the real answer, with no effect in between. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
