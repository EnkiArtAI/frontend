"use client";

import { useCallback, useState } from "react";

/** A picked image file as a data URL; null when the browser cannot read it, so nothing waits forever. */
export function readImageFile(file: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" && reader.result ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * Reference images are read in the browser before they can travel with a
 * generation. While one is still being read, Generate waits: a click in that
 * moment paid for a picture that never saw the image (Kev, 2026-10-06).
 *
 * `pending` holds a greyed preview of each image still being read (Kev: shown
 * greyed while it loads, gone if it fails, kept once it is in). The previews
 * are blob: URLs and live only here, never in a reference list, so none can
 * be saved with a draft or sent with a generation.
 */
export function useReferenceReads() {
  const [pending, setPending] = useState<string[]>([]);
  const read = useCallback(async (file: Blob) => {
    const preview = URL.createObjectURL(file);
    setPending((p) => [...p, preview]);
    try {
      return await readImageFile(file);
    } finally {
      setPending((p) => p.filter((u) => u !== preview));
      URL.revokeObjectURL(preview);
    }
  }, []);
  return { loading: pending.length > 0, pending, read };
}

/** What a refused Generate says while images are still being read. */
export const REFS_LOADING = "Reference images are still loading. Generate again once they appear.";
