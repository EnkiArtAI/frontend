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

/** One shared import: concurrent first imports of the same module are needless work. */
let blobSdk: Promise<typeof import("@vercel/blob")> | null = null;
const loadBlob = () => (blobSdk ??= import("@vercel/blob"));
let dbModule: Promise<typeof import("@/lib/supabaseServer")> | null = null;
const loadDb = () => (dbModule ??= import("@/lib/supabaseServer"));

async function putBlob(name: string, buf: Buffer, contentType: string): Promise<string | null> {
  try {
    const { put } = await loadBlob();
    const { url } = await put(name, buf, { access: "public", contentType, addRandomSuffix: false });
    return url;
  } catch (e) {
    console.warn("[derivative-store] upload failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Raw bytes that still fit inline: a function's response is capped at 4.5 MB
 * and base64 adds a third. A 2K PNG is ~7 MB, so only small renders qualify.
 */
export const INLINE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * When a paid route must have its image stored by: maxDuration (300 s) minus
 * the 15 s the capture (broadcast, ledger, nonce close) and the answer need.
 * Never later: a render that runs past it gets less store time, not a capture
 * the platform kills halfway.
 */
export function storeDeadline(startedAt: number): number {
  return startedAt + 285_000;
}

/**
 * Where a generated image falls back to when Vercel Blob cannot take it: a
 * public Supabase Storage bucket (Kev, 2026-10-06: "supabase storage als
 * automatischer speicher"). A 2K or 4K image is too big to travel inline, so
 * without a second store a Blob outage would cost the image. Created by
 * migrations/2026-10-06-generations-bucket.sql.
 */
export const FALLBACK_BUCKET = "generations";

/** One store's turn: the Blob SDK retries outages inside a put, so a turn needs its own end. */
const TURN_MS = 20_000;

type Store = {
  put: (name: string, buf: Buffer, contentType: string, signal: AbortSignal) => Promise<string>;
  /** Whether a failure can pass; one that cannot takes the store out of this put. */
  passing: (e: unknown) => boolean;
};

/** The stores this deployment can write to, Blob first. */
async function stores(): Promise<Store[]> {
  const out: Store[] = [];
  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    const blob = await loadBlob();
    out.push({
      put: (name, buf, contentType, abortSignal) =>
        blob.put(name, buf, { access: "public", contentType, addRandomSuffix: false, allowOverwrite: true, abortSignal }).then((r) => r.url),
      passing: (e) =>
        !(e instanceof blob.BlobError) ||
        e instanceof blob.BlobServiceRateLimited ||
        e instanceof blob.BlobServiceNotAvailable ||
        e instanceof blob.BlobUnknownError,
    });
  }
  const { getSupabaseServerClientSafe } = await loadDb();
  const bucket = getSupabaseServerClientSafe()?.storage.from(FALLBACK_BUCKET);
  if (bucket) {
    out.push({
      put: async (name, buf, contentType) => {
        const { error } = await bucket.upload(name, buf, { contentType, upsert: true });
        if (error) throw error;
        return bucket.getPublicUrl(name).data.publicUrl;
      },
      // A 4xx (no bucket, no rights, too large) is refused again; 5xx, 429 and the network can pass.
      passing: (e) => {
        const status = (e as { status?: number } | null)?.status;
        return status === undefined || status >= 500 || status === 429;
      },
    });
  }
  return out;
}

/**
 * Put one object, retrying until it lands or `deadline` (epoch ms) passes.
 *
 * An image that was made is delivered (Kev, 2026-10-06: "bild upload darf
 * nicht failen. ist ein bild erstellt worden, so muss das geliefert werden").
 * Each round gives Blob a turn and then the fallback bucket, so an outage on
 * one store costs one turn, not the image. A turn is a race against its own
 * end, because the Blob SDK retries outages for up to ~17 minutes and its
 * backoff ignores any signal; the abort that ends it carries no reason,
 * which makes it an AbortError, the one error the SDK stops on (a
 * TimeoutError it retries). A failure that cannot pass (a bad token, a
 * suspended store, a missing bucket) takes that store out of this put.
 * Overwrite is allowed because a lost response may hide a put that landed,
 * and the retry carries the same bytes. Null when no store is configured.
 */
export async function putDurably(name: string, buf: Buffer, contentType: string, deadline: number): Promise<string | null> {
  const live = deadline > Date.now() ? await stores() : [];
  for (let wait = 1_000; live.length; wait = Math.min(wait * 2, 8_000)) {
    for (const store of [...live]) {
      const turn = Math.min(TURN_MS, deadline - Date.now());
      if (turn <= 0) return null;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), turn);
      const over = new Promise<null>((r) => ac.signal.addEventListener("abort", () => r(null), { once: true }));
      const attempt = store.put(name, buf, contentType, ac.signal);
      attempt.catch(() => {}); // still running when the turn ends first
      try {
        const url = await Promise.race([attempt, over]);
        if (url) return url;
      } catch (e) {
        console.warn("[derivative-store] upload failed:", e instanceof Error ? e.message : e);
        if (!store.passing(e)) live.splice(live.indexOf(store), 1);
      } finally {
        clearTimeout(timer);
      }
    }
    if (!live.length || Date.now() + wait >= deadline) return null;
    await new Promise((r) => setTimeout(r, wait)); // ends before the deadline: checked above
  }
  return null;
}

/** A file already in one of our stores stays where it is, so its stored URL is the one the client was given. */
function inOurBlob(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname.endsWith(".public.blob.vercel-storage.com") ||
      (u.hostname.endsWith(".supabase.co") && u.pathname.startsWith(`/storage/v1/object/public/${FALLBACK_BUCKET}/`))
    );
  } catch {
    return false;
  }
}

/** With `deadline`, every put is durable and bounded by it (putDurably); without, one attempt each as before. */
export async function storeGeneratedImage(providerUrl: string, userId: string, deadline?: number): Promise<StoredImage> {
  const passthrough: StoredImage = { imageUrl: providerUrl, previewUrl: null, thumbnailUrl: null };
  // With a deadline the fallback bucket may still take it; putDurably decides.
  if (!deadline && !process.env.BLOB_READ_WRITE_TOKEN?.trim()) return passthrough;

  try {
    const fetched = await fetchBytes(providerUrl);
    if (!fetched) return passthrough;

    const ext = fetched.contentType.includes("png") ? "png" : fetched.contentType.includes("webp") ? "webp" : "jpg";
    const base = `generations/${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const store = (name: string, buf: Buffer, type: string, by = deadline) =>
      by ? putDurably(name, buf, type, by) : putBlob(name, buf, type);
    const [original, derivatives] = await Promise.all([
      inOurBlob(providerUrl) ? Promise.resolve(providerUrl) : store(`${base}.${ext}`, fetched.buf, fetched.contentType),
      tryMakeDerivatives(fetched.buf),
    ]);

    // Renditions are optional: none without a stored original, and never more
    // than 10 s of a paying caller's wait.
    const renditionsBy = deadline && Math.min(deadline, Date.now() + 10_000);
    const [previewUrl, thumbnailUrl] = derivatives && original
      ? await Promise.all([
          store(`${base}.preview.webp`, derivatives.preview.buffer, "image/webp", renditionsBy),
          store(`${base}.thumb.webp`, derivatives.thumb.buffer, "image/webp", renditionsBy),
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
