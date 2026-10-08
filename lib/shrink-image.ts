import { REQUEST_MAX_BYTES } from "@/lib/request-size";

/**
 * Images made smaller in the browser before they travel. Vercel turns away a
 * request body over 4.5 MB before any route of ours runs, and a reference
 * travels as base64, a third larger than its bytes.
 *
 * Kev, 2026-10-08: every reference at most 1024 px on its long edge, as WebP
 * at 0.85, transparency kept. 1024 px is the edge the image check judges at
 * (lib/moderation/image-check-bytes), so the judges lose nothing. An
 * animation decodes to its first frame: one still is what is judged and sent.
 */
const REFERENCE_EDGE = 1024;
const REFERENCE_QUALITY = 0.85;

/** The size that brings the long edge down to `edge`: never larger than the image, never 0 px. */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** No pixel lets anything behind it show through. */
function opaque(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return false;
  return true;
}

/**
 * The canvas as WebP. Safari encodes no WebP and silently hands back a PNG,
 * several times larger: an opaque image then goes as a JPEG of the same
 * quality, a transparent one stays that PNG, so its transparency is kept.
 */
export async function encodeCanvas(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  const webp = await toBlob(canvas, "image/webp", quality);
  if (!webp || webp.type === "image/webp") return webp;
  return opaque(canvas) ? toBlob(canvas, "image/jpeg", quality) : webp;
}

/**
 * An image as it is sent: upright as the camera meant it, at most `edge` px
 * on its long side. One the browser cannot decode (HEIC outside Safari, an
 * SVG) goes as it came, for the server to judge.
 */
export async function shrinkImage(src: Blob, edge = REFERENCE_EDGE, quality = REFERENCE_QUALITY): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(src, { imageOrientation: "from-image" });
    const { width, height } = fitWithin(bitmap.width, bitmap.height, edge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return src;
    // The default ("low") aliases a photo shrunk several times over.
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return (await encodeCanvas(canvas, quality)) ?? src;
  } catch {
    return src;
  }
}

/**
 * Tried in order until a gallery or message image fits: quality before size,
 * and size last for the one kind with no quality to give (Safari's PNG of a
 * transparent image). Measured 2026-10-08 with libwebp: a 4K render (14.2 MB
 * PNG) is 961 KB at the first step; pure noise, the worst case, fits at the third.
 */
const UPLOAD_STEPS = [
  { edge: 2560, quality: 0.9 },
  { edge: 2560, quality: 0.8 },
  { edge: 2560, quality: 0.7 },
  { edge: 2048, quality: 0.7 },
  { edge: 1600, quality: 0.7 },
];

/**
 * A showcase or message image as it is sent: always drawn anew, so nothing
 * the camera wrote into the file goes along (a phone photo carries where it
 * was taken, and a gallery original is public), at the first step that fits.
 * Null when none does or the browser cannot read it. It travels alone in a
 * multipart body, as bytes: no base64 here.
 */
export async function fitUpload(file: File): Promise<File | null> {
  for (const { edge, quality } of UPLOAD_STEPS) {
    const blob = await shrinkImage(file, edge, quality);
    // Handed back as it came: the browser could not read it, and no step will.
    if (blob === file) return null;
    if (blob.size <= REQUEST_MAX_BYTES) return new File([blob], `${file.name.replace(/\.[^.]*$/, "")}.${blob.type.split("/")[1]}`, { type: blob.type });
  }
  return null;
}
