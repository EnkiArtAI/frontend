import sharp from "sharp";
import { checkImage, type CheckedImage } from "@/lib/moderation/image-check";

/** The edge the judges see: what the calibration of 2026-10-08 used. */
const EDGE = 1024;

/** Formats a browser shows as one still picture, when they hold one frame. */
const STILL = new Set(["jpeg", "png", "webp", "gif"]);

/** An APNG names its frames in an acTL chunk; libvips reads only the first frame. */
function isApng(png: Buffer): boolean {
  for (let at = 8; at + 8 <= png.length; at += 12 + png.readUInt32BE(at)) {
    if (png.toString("latin1", at + 4, at + 8) === "acTL") return true;
  }
  return false;
}

/** The reason "unavailable" gives for bytes no image decoder reads. */
export const NOT_AN_IMAGE = "not an image";

/** Of two views of one image, the worse verdict stands, a child-safety one above all. */
const RANK = { clear: 0, adult: 1, unavailable: 2, blocked: 3, child_safety: 4 } as const;

/**
 * Check image bytes the way the calibration did: the judges see a JPEG of at
 * most 1024 px, whatever the stored original weighs. A 4K PNG inline would
 * cost more tokens than calibrated and may exceed what the APIs accept; a URL
 * would leave the judging to whatever the host serves. Bytes that do not
 * decode as an image are nothing anyone may see: "unavailable".
 *
 * The judges see one frame, so an animation, or a format a browser may play
 * as one, is refused rather than judged by its first frame. A transparent
 * image shows whatever is behind it, so it is judged on black and on white:
 * a picture drawn in the alpha channel alone shows on one of them.
 */
export async function checkImageBytes(bytes: Buffer, opts: { signal?: AbortSignal } = {}): Promise<CheckedImage> {
  let views: Buffer[];
  try {
    const meta = await sharp(bytes).metadata();
    if (!STILL.has(meta.format) || (meta.pages ?? 1) > 1 || (meta.format === "png" && isApng(bytes))) return { verdict: "blocked", reason: "not a still" };
    const backgrounds = meta.hasAlpha && !(await sharp(bytes).stats()).isOpaque ? ["#000000", "#ffffff"] : ["#000000"];
    views = await Promise.all(backgrounds.map((background) =>
      sharp(bytes).rotate().resize({ width: EDGE, height: EDGE, fit: "inside", withoutEnlargement: true }).flatten({ background }).jpeg({ quality: 85 }).toBuffer()));
  } catch {
    return { verdict: "unavailable", reason: NOT_AN_IMAGE };
  }
  const seen = await Promise.all(views.map((v) => checkImage(`data:image/jpeg;base64,${v.toString("base64")}`, opts)));
  return seen.reduce((worst, v) => (RANK[v.verdict] > RANK[worst.verdict] ? v : worst));
}

/**
 * What the owner of a refused image reads: one sentence for explicit content
 * and child safety alike, so a noisy verdict never accuses anyone.
 */
export const IMAGE_REFUSED = "This image can't be delivered on Enki. Nothing was charged.";
/** When the judges gave no verdict: the image is held back, never shown unchecked. */
export const IMAGE_UNCHECKED = "Your image could not be checked right now, so it was not delivered. Nothing was charged. Please try again.";
export const REFERENCE_REFUSED = "One of your reference images can't be used on Enki. Nothing was generated and nothing was charged.";
/** A reference sent as a link: nothing here fetches an address a user names, so it comes as the image itself. */
export const REFERENCE_LINK = "Reference images must be attached as images, not links. Nothing was generated and nothing was charged.";
export const REFERENCE_UNCHECKED = "Your reference images could not be checked right now. Nothing was generated and nothing was charged. Please try again.";

export const UPLOAD_REFUSED = "This image can't be uploaded to Enki.";
export const UPLOAD_UNCHECKED = "Your image could not be checked right now, so it was not uploaded. Please try again.";

/** A profile image is public everywhere and has no 18+ mark: only a clear one is taken. */
export const PROFILE_IMAGE_ADULT = "A profile picture or cover can't be 18+ on Enki.";

/** A message has no 18+ mark and can reach anyone: only a clear image is sent. */
export const MESSAGE_IMAGE_ADULT = "18+ images can't be sent in messages.";

/** Refused or not judged: such an image is neither shown nor used. */
export const heldBack = (v: { verdict: string }) => v.verdict === "blocked" || v.verdict === "child_safety" || v.verdict === "unavailable";

/** A reference that names an address (https:, blob:, ipfs: …) rather than carrying the image. */
export const isLink = (ref: string) => /^(?!data:)[a-z][a-z0-9+.-]*:/i.test(ref.trim());

/** The bytes of a base64 data: URL, or null for anything else. */
export function dataUrlBytes(url: string): Buffer | null {
  const m = /^data:[^;,]+;base64,([\s\S]*)$/.exec(url);
  return m ? Buffer.from(m[1], "base64") : null;
}
