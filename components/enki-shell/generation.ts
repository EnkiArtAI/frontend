/**
 * Node Creator ("Create Prompt 2") helpers that are not a generation.
 * Generating goes through lib/generation/run-generation.ts like every surface.
 *
 *  - placeholderArt(): the design's deterministic SVG-gradient generator, for
 *    the decorative seed/reference nodes and mock-up mode. Never a stand-in
 *    for a failed generation.
 *  - persistCreation(): best-effort hook to save a finished render to the
 *    user's database/gallery, swallowing errors so an unconfigured DB never
 *    breaks the editor.
 */

import { addCreation } from "@/lib/creations";

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
