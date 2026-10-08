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
 * A reference as a data URL: a file is read in place, a link (a wallet NFT's
 * image) is fetched first. The server judges every reference by its bytes and
 * never fetches an address a user names.
 */
export async function readReference(src: Blob | string): Promise<string | null> {
  // A host that never answers would hold Generate for good: 20 s at most.
  const blob = typeof src === "string"
    ? await fetch(src, { signal: AbortSignal.timeout(20_000) }).then((r) => (r.ok ? r.blob() : null), () => null)
    : src;
  return blob ? readImageFile(blob) : null;
}

/** Each link read is its own pending entry: two NFTs often share one image address. */
let linkReads = 0;

/**
 * Reference images are read in the browser before they can travel with a
 * generation. While one is still being read, Generate waits: a click in that
 * moment paid for a picture that never saw the image (Kev, 2026-10-06).
 *
 * `pending` holds a greyed preview of each image still being read (Kev: shown
 * greyed while it loads, gone if it fails, kept once it is in). The previews
 * are blob: URLs and live only here, never in a reference list, so none can
 * be saved with a draft or sent with a generation.
 * A link is previewed by its own address while it loads, made unique by a
 * fragment, so one finished read never clears another of the same address.
 */
export function useReferenceReads() {
  const [pending, setPending] = useState<string[]>([]);
  const read = useCallback(async (file: Blob | string) => {
    const preview = typeof file === "string" ? `${file}#read-${++linkReads}` : URL.createObjectURL(file);
    setPending((p) => [...p, preview]);
    try {
      return await readReference(file);
    } finally {
      setPending((p) => p.filter((u) => u !== preview));
      if (typeof file !== "string") URL.revokeObjectURL(preview);
    }
  }, []);
  return { loading: pending.length > 0, pending, read };
}

/** What a refused Generate says while images are still being read. */
export const REFS_LOADING = "Reference images are still loading. Generate again once they appear.";
