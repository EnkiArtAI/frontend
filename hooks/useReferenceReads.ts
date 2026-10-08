"use client";

import { useCallback, useState } from "react";
import { shrinkImage } from "@/lib/shrink-image";
import { sessionAuthHeaders } from "@/lib/session-headers";

/** A picked image file as a data URL; null when the browser cannot read it, so nothing waits forever. */
export function readImageFile(file: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" && reader.result ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** A wallet NFT as the picker hands it over: the picture the list named, and the tile it showed. */
export type NftPick = { image: string; thumb: string };

/**
 * A reference as a data URL: a file is read in place, a picked NFT through
 * our own route (/api/wallet/nfts/image), which reads it through the Helius
 * CDN, so no host's CORS or downtime decides whether it loads. Either is made
 * smaller first, so every reference fits a request (lib/shrink-image), and the
 * server judges every reference by its bytes.
 */
export async function readReference(src: Blob | NftPick): Promise<string | null> {
  // A route that never answers would hold Generate for good: 20 s at most.
  const blob = src instanceof Blob
    ? src
    : await fetch(`/api/wallet/nfts/image?src=${encodeURIComponent(src.image)}`, {
        headers: sessionAuthHeaders(),
        signal: AbortSignal.timeout(20_000),
      }).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
  return blob ? readImageFile(await shrinkImage(blob)) : null;
}

/** Each NFT read is its own pending entry: one NFT can be picked twice, and two often share an image. */
let nftReads = 0;

/**
 * Reference images are read in the browser before they can travel with a
 * generation. While one is still being read, Generate waits: a click in that
 * moment paid for a picture that never saw the image (Kev, 2026-10-06).
 *
 * `pending` holds a greyed preview of each image still being read (Kev: shown
 * greyed while it loads, gone if it fails, kept once it is in). The previews
 * are blob: URLs and live only here, never in a reference list, so none can
 * be saved with a draft or sent with a generation.
 * An NFT is previewed by its tile while it loads, made unique by a fragment,
 * so one finished read never clears another of the same tile.
 */
export function useReferenceReads() {
  const [pending, setPending] = useState<string[]>([]);
  const read = useCallback(async (file: Blob | NftPick) => {
    const preview = file instanceof Blob ? URL.createObjectURL(file) : `${file.thumb}#read-${++nftReads}`;
    setPending((p) => [...p, preview]);
    try {
      return await readReference(file);
    } finally {
      setPending((p) => p.filter((u) => u !== preview));
      if (file instanceof Blob) URL.revokeObjectURL(preview);
    }
  }, []);
  return { loading: pending.length > 0, pending, read };
}

/** What a refused Generate says while images are still being read. */
export const REFS_LOADING = "Reference images are still loading. Generate again once they appear.";
