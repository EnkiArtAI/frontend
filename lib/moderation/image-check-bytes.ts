import sharp from "sharp";
import { checkImage, type CheckedImage } from "@/lib/moderation/image-check";

/** The edge the judges see: what the calibration of 2026-10-08 used. */
const EDGE = 1024;

/**
 * Check image bytes the way the calibration did: the judges see a JPEG of at
 * most 1024 px, whatever the stored original weighs. A 4K PNG inline would
 * cost more tokens than calibrated and may exceed what the APIs accept; a URL
 * would leave the judging to whatever the host serves. Bytes that do not
 * decode as an image are nothing anyone may see: "unavailable".
 */
export async function checkImageBytes(bytes: Buffer, opts: { signal?: AbortSignal } = {}): Promise<CheckedImage> {
  let jpeg: Buffer;
  try {
    jpeg = await sharp(bytes).rotate().resize({ width: EDGE, height: EDGE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } catch {
    return { verdict: "unavailable", reason: "not an image" };
  }
  return checkImage(`data:image/jpeg;base64,${jpeg.toString("base64")}`, opts);
}

/**
 * What the owner of a refused image reads: one sentence for explicit content
 * and child safety alike, so a noisy verdict never accuses anyone.
 */
export const IMAGE_REFUSED = "This image can't be delivered on Enki. Nothing was charged.";
/** When the judges gave no verdict: the image is held back, never shown unchecked. */
export const IMAGE_UNCHECKED = "Your image could not be checked right now, so it was not delivered. Nothing was charged. Please try again.";
export const REFERENCE_REFUSED = "One of your reference images can't be used on Enki. Nothing was generated and nothing was charged.";
export const REFERENCE_UNCHECKED = "Your reference images could not be checked right now. Nothing was generated and nothing was charged. Please try again.";

/** Refused or not judged: such an image is neither shown nor used. */
export const heldBack = (v: { verdict: string }) => v.verdict === "blocked" || v.verdict === "child_safety" || v.verdict === "unavailable";

/** The bytes of a base64 data: URL, or null for anything else. */
export function dataUrlBytes(url: string): Buffer | null {
  const m = /^data:[^;,]+;base64,([\s\S]*)$/.exec(url);
  return m ? Buffer.from(m[1], "base64") : null;
}
