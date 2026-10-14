import { downloadName } from "@/lib/ui/kit/format";
import { notify } from "./notify";

/**
 * Download and share for the Image View header and the viewer (plan §1.2).
 * Each tries the richest way the browser offers and falls back in a fixed
 * order; a share sheet the user dismissed ends it silently.
 */

const isLink = (url: string) => /^https?:\/\//i.test(url);

async function blobOf(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

/** The image as a file, when this browser can share files at all. */
async function fileOf(url: string): Promise<File | null> {
  if (typeof navigator.canShare !== "function") return null;
  const blob = await blobOf(url);
  const file = blob && new File([blob], downloadName("enki", 1, blob.type), { type: blob.type });
  return file && navigator.canShare({ files: [file] }) ? file : null;
}

/** Runs each way in turn until one works. True when one did, or the user dismissed a share sheet. */
async function attempt(ways: Array<(() => Promise<unknown>) | false>): Promise<boolean> {
  for (const way of ways) {
    if (!way) continue;
    try {
      await way();
      return true;
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return true;
    }
  }
  return false;
}

/**
 * Saves the original: fetched as a blob, named "title-n" with the extension
 * its type names (the label never says a format). A host that will not hand
 * the bytes over (CORS) opens it in a new tab instead.
 */
export async function downloadImage(url: string, title: string, n: number): Promise<void> {
  const blob = await blobOf(url);
  if (!blob) {
    window.open(url, "_blank", "noopener");
    notify("Opened in a new tab");
    return;
  }
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href, download: downloadName(title, n, blob.type) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** The image itself: as a file, else its link through the share sheet, else its link copied. A render the store missed has no link. */
export async function shareImage(url: string): Promise<void> {
  const file = await fileOf(url);
  const link = isLink(url);
  const done = await attempt([
    !!file && (() => navigator.share({ files: [file] })),
    link && typeof navigator.share === "function" && (() => navigator.share({ url })),
    link && (async () => {
      await navigator.clipboard.writeText(url);
      notify("Image link copied");
    }),
  ]);
  if (!done) notify(link ? "Couldn't share this image" : "This image has no link yet");
}

/**
 * The image with the prompt's page: one share with both, else the link
 * shared, else both links copied. It never carries a premium prompt's text.
 */
export async function shareWithLink(url: string, link: string, title: string): Promise<void> {
  const file = await fileOf(url);
  const text = `${title} on Enki Art`;
  const done = await attempt([
    !!file && (() => navigator.share({ title, text, url: link, files: [file] })),
    typeof navigator.share === "function" && (() => navigator.share({ title, text, url: link })),
    async () => {
      await navigator.clipboard.writeText(isLink(url) ? `${url}\n${link}` : link);
      notify(isLink(url) ? "Image and prompt link copied" : "Link copied");
    },
  ]);
  if (!done) notify("Couldn't share this image");
}
