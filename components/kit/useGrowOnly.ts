"use client";

import { useCallback, useState } from "react";
import { holdKeys, releaseKey } from "@/lib/ui/kit/grow-only";

/**
 * Which fields may only grow, per field (plan R9; handoff §0 "kein
 * Hochzucken"): loading an image's values holds every field they fill, so
 * nothing jumps; typing in a field releases that field alone, which may
 * then shrink again.
 */
export function useGrowOnly() {
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const hold = useCallback((keys: readonly string[]) => setHeld((h) => holdKeys(h, keys)), []);
  const release = useCallback((key: string) => setHeld((h) => releaseKey(h, key)), []);
  const isHeld = useCallback((key: string) => held.has(key), [held]);
  return { isHeld, hold, release };
}
