/**
 * Image generation for the Node Creator ("Create Prompt 2").
 *
 *  - generateNanoBanana(): real, FREE image generation via the project's own
 *    /api/generate-free endpoint (Pollinations) — no key, sign-in, or payment.
 *  - placeholderArt(): the design's deterministic SVG-gradient generator, used
 *    for the decorative seed/reference nodes and as a graceful fallback.
 *  - persistCreation(): best-effort hook to save a finished render to the
 *    user's database/gallery. Touches no backend code — it just POSTs to the
 *    existing gallery endpoint and to the local creations store, swallowing
 *    errors so an unconfigured DB never breaks the editor.
 */

import { addCreation } from "@/lib/creations";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { authorizePaidGeneration, type PaymentSigner } from "@/lib/generation-checkout";

/**
 * ── What this file used to claim, and what it did ───────────────────────
 * `generateNanoBanana()` posted to /api/generate-free, which is Pollinations
 * running flux. So the node editor offered "Nano Banana Pro", showed a price,
 * put "Pay & Gen" on the button — and generated free flux, charged nothing,
 * and ignored the model entirely. Three claims, none of them true.
 *
 * The function is now named for what it does, and generateWithModel() below
 * routes by the model the user actually picked.
 */
export const NANO_BANANA_MODEL = "gemini-3-pro-image";

/** A model as the catalogue describes it — /api/models, never a constant. */
export interface CatalogueModel {
  id: string;
  name: string;
  /** USD per image. 0 means the free tier. */
  price: number;
}

/**
 * Generate with the model the user chose.
 *
 * A free model goes to /api/generate-free. A paid one holds a payment first
 * (intent → authorize → sign → submit, lib/generation-checkout) and generates
 * with the intentId; the server captures only after the image is stored and
 * voids on any failure. The model id travels too, so the server refuses a
 * request whose model disagrees with what was paid for.
 *
 * Returns the image URL, or an { error } the caller can show — a paid
 * generation without a settled payment must say so rather than quietly
 * handing back a free picture from a different model.
 */
export async function generateWithModel(opts: {
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  model: CatalogueModel | null;
  boost?: boolean;
  quality?: "low" | "medium" | "high";
  workflow?: unknown;
  /** Signs the payment with the buyer's wallet (hooks/usePaymentSigner). */
  sign: PaymentSigner;
}): Promise<{ url: string } | { error: string }> {
  const { prompt, aspectRatio = "1:1", resolution = "2K", model, boost, quality, workflow, sign } = opts;
  const isFree = !model || model.price <= 0;

  try {
    let res: Response;
    if (isFree) {
      res = await fetch("/api/generate-free", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, aspectRatio, resolution, workflow }),
      });
    } else {
      const tier = (["1K", "2K", "4K"] as const).find((t) => t === resolution);
      if (!tier) return { error: "Pick a resolution first. Nothing was charged." };
      const { intentId } = await authorizePaidGeneration(
        { modelId: model.id, resolution: tier, boost: !!boost, quality },
        sign,
      );
      res = await fetch("/api/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ intentId, prompt, aspectRatio, workflow, modelIds: [model.id], boost: !!boost, quality }),
      });
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { error: body.error || `Generation failed (${res.status})` };
    }
    const data = await res.json();
    return typeof data?.imageUrl === "string"
      ? { url: data.imageUrl }
      : { error: "No image returned" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Generation failed" };
  }
}

/**
 * Generate a single image for the node creator via the project's own
 * generation endpoint (`/api/generate-free` → Pollinations), which returns a
 * real image as a data URL with no API key, sign-in, or payment. Returns the
 * URL, or null on failure (the caller falls back to a placeholder).
 *
 * To switch to paid Nano Banana Pro (Gemini) generation, point this at
 * `/api/generate-image` once a balance / x402 payment flow is wired for the
 * editor — that endpoint is payment-gated by design.
 */
export async function generateNanoBanana(
  prompt: string,
  aspectRatio = "1:1",
  /**
   * The node graph that produced this prompt, from buildExportJSON(). Sent so
   * the generation can be re-run later: the server pulls the image bytes and
   * the authored text out of it, stores the structure as jsonb and the text
   * encrypted (lib/generation/workflow.ts). Without it a generation records
   * what came out but not how it was built.
   */
  workflow?: unknown,
): Promise<string | null> {
  try {
    const res = await fetch("/api/generate-free", {
      method: "POST",
      /* The session travels with a FREE generation too. Without it
         resolveRecordingUserId returns null and the route skips its whole
         recorder block, so a signed-in user's free images belonged to
         nobody and never reached their history. */
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ prompt, aspectRatio, workflow }),
    });
    if (!res.ok) { console.warn("[node-creator] generation failed:", res.status); return null; }
    const data = await res.json();
    return typeof data?.imageUrl === "string" ? data.imageUrl : null;
  } catch (e) {
    console.warn("[node-creator] generation failed:", e);
    return null;
  }
}

/**
 * Best-effort persistence to the user's gallery/DB + local creations store so
 * the render shows up in "My Gallery". Never throws.
 */
export async function persistCreation(opts: {
  prompt: string;
  imageUrl: string;
  model: string;
  title?: string;
  userKey?: string | null;
}): Promise<void> {
  const { prompt, imageUrl, model, title, userKey } = opts;
  // 1) local creations store (instant, offline-safe) — what My Gallery merges in.
  try {
    addCreation(userKey || "guest", {
      id: "nc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      imageUrl,
      prompt,
      createdAt: new Date().toISOString(),
    });
  } catch {
    /* ignore */
  }
  // 2) server gallery (only succeeds when DB/auth are configured; harmless otherwise).
  try {
    await fetch("/api/gallery/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ imageUrl, prompt, model, title, source: "node-creator" }),
    });
  } catch {
    /* ignore — DB not configured locally */
  }
}

/* ── deterministic placeholder art (ported from the design's data.js) ── */
const PALETTES: Record<string, string[]> = {
  Cinematic: ["#0a1020", "#ff7a3c", "#1b6ca8", "#ffd28a"],
  Character: ["#10131f", "#7c5cff", "#27c2a0", "#e9c46a"],
  Abstract: ["#160a20", "#ff4d6d", "#4dd0e1", "#ffd166"],
  Portrait: ["#2a1410", "#e8a06a", "#b23b3b", "#f0d9b5"],
  Editorial: ["#1c1814", "#c98a5a", "#7a8b74", "#d8c7a8"],
};
const RESULT_PALS = Object.values(PALETTES);

function rng(str: string) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function genArt(seedStr: string, w: number, h: number, pal: string[]) {
  const r = rng(seedStr);
  let defs = "";
  let layers = "";
  const accents = [pal[1], pal[2], pal[3], pal[2], pal[1]];
  accents.forEach((c, k) => {
    const cx = (r() * 100).toFixed(1);
    const cy = (r() * 100).toFixed(1);
    const rad = (38 + r() * 46).toFixed(1);
    const id = "g" + k;
    defs +=
      '<radialGradient id="' + id + '" cx="' + cx + '%" cy="' + cy + '%" r="' + rad + '%">' +
      '<stop offset="0%" stop-color="' + c + '" stop-opacity="0.92"/>' +
      '<stop offset="100%" stop-color="' + c + '" stop-opacity="0"/></radialGradient>';
    layers += '<rect width="' + w + '" height="' + h + '" fill="url(#' + id + ')"/>';
  });
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '">' +
    "<defs>" + defs +
    '<linearGradient id="sh" x1="0" y1="0" x2="0" y2="1"><stop offset="55%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.22"/></linearGradient></defs>' +
    '<rect width="' + w + '" height="' + h + '" fill="' + pal[0] + '"/>' + layers +
    '<rect width="' + w + '" height="' + h + '" fill="url(#sh)"/>' +
    "</svg>";
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

export function placeholderArt(seed: string, ratio: string): string {
  const map: Record<string, [number, number]> = { "16:9": [768, 432], "9:16": [432, 768], "4:5": [560, 700], "3:4": [540, 720] };
  const [w, h] = map[ratio] || [640, 640];
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) >>> 0;
  const pal = RESULT_PALS[n % RESULT_PALS.length];
  return genArt(seed, w, h, pal);
}
