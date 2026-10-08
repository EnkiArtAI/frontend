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

/** The bytes of a base64 data: URL, or null for anything else. */
export function dataUrlBytes(url: string): Buffer | null {
  const m = /^data:[^;,]+;base64,([\s\S]*)$/.exec(url);
  return m ? Buffer.from(m[1], "base64") : null;
}
