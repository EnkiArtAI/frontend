/**
 * Store a freshly generated image in OUR blob store and cut its WebP
 * renditions (Kev, 2026-08-23: "ich brauch webp auf allen images die
 * angezeigt werden ... damit das laden der bilder rasant verläuft").
 *
 * Why store the original at all: the provider URL is a rented link on
 * someone else's CDN — it can expire, and every view pays their bandwidth
 * prices in latency. One fetch at generation time turns it into three
 * stable objects of ours:
 *
 *   original    what the download button hands over
 *   preview     WebP ~1280px — what the UI displays
 *   thumb       WebP ~384px  — grids and strips
 *
 * TOKEN-GRACEFUL: BLOB_READ_WRITE_TOKEN is empty today (Kev's to-do). With
 * no token the provider URL passes through untouched and nothing breaks;
 * the pipeline arms itself the moment the token lands. And it NEVER throws:
 * a failed optimisation must not cost the image that was already paid for.
 */
import { tryMakeDerivatives } from "@/lib/imageDerivatives";

export interface StoredImage {
  imageUrl: string;
  previewUrl: string | null;
  thumbnailUrl: string | null;
}

async function fetchBytes(url: string): Promise<{ buf: Buffer; contentType: string } | null> {
  // Providers answer with a CDN URL or (OpenAI) a data: URI — both are bytes.
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) return null;
    const meta = url.slice(5, comma);
    return {
      buf: Buffer.from(url.slice(comma + 1), meta.includes("base64") ? "base64" : "utf8"),
      contentType: meta.split(";")[0] || "image/png",
    };
  }
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return null;
  return {
    buf: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "image/jpeg",
  };
}

async function putBlob(name: string, buf: Buffer, contentType: string): Promise<string | null> {
  try {
    const { put } = await import("@vercel/blob");
    const { url } = await put(name, buf, { access: "public", contentType, addRandomSuffix: false });
    return url;
  } catch (e) {
    console.warn("[derivative-store] upload failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** A file already in our Blob store stays where it is, so its stored URL is the one the client was given. */
function inOurBlob(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

export async function storeGeneratedImage(providerUrl: string, userId: string): Promise<StoredImage> {
  const passthrough: StoredImage = { imageUrl: providerUrl, previewUrl: null, thumbnailUrl: null };
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) return passthrough;

  try {
    const fetched = await fetchBytes(providerUrl);
    if (!fetched) return passthrough;

    const ext = fetched.contentType.includes("png") ? "png" : fetched.contentType.includes("webp") ? "webp" : "jpg";
    const base = `generations/${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const [original, derivatives] = await Promise.all([
      inOurBlob(providerUrl) ? Promise.resolve(providerUrl) : putBlob(`${base}.${ext}`, fetched.buf, fetched.contentType),
      tryMakeDerivatives(fetched.buf),
    ]);

    const [previewUrl, thumbnailUrl] = derivatives
      ? await Promise.all([
          putBlob(`${base}.preview.webp`, derivatives.preview.buffer, "image/webp"),
          putBlob(`${base}.thumb.webp`, derivatives.thumb.buffer, "image/webp"),
        ])
      : [null, null];

    return {
      // Our stable copy when the upload worked; the rented link otherwise.
      imageUrl: original ?? providerUrl,
      previewUrl,
      thumbnailUrl,
    };
  } catch (e) {
    console.warn("[derivative-store] failed:", e instanceof Error ? e.message : e);
    return passthrough;
  }
}
