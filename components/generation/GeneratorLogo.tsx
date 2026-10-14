"use client";

import { siGooglegemini } from "simple-icons";
import { toModelFamily } from "@/lib/generation/model-family";

/**
 * Colored mark per generator, shown before its name (Kev, 2026-08-24:
 * "find logos for each of the generators … must be colored ones").
 *
 * Nano Banana Pro carries the real Gemini spark (simple-icons path) in the
 * brand's blue→violet gradient. GPT rides a six-petal knot built
 * geometrically — simple-icons removed the OpenAI mark on trademark
 * request, so this is our own rotationally-symmetric echo in the familiar
 * green. Flux carries the Black Forest Labs triangle (handoff §0, Kev's
 * product call 3, 2026-10-09), in currentColor because that mark is
 * monochrome: it follows the text it sits in on every theme. Unknown models
 * fall back to a neutral dot so a new row is never iconless.
 */
export default function GeneratorLogo({ name, size = 14 }: { name: string; size?: number }) {
  const family = toModelFamily(name);
  if (family === "nano-banana-pro" || /gemini|banana/i.test(name)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <defs>
          <linearGradient id="gl-gem" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#1C7DFF" />
            <stop offset="55%" stopColor="#4E8FF7" />
            <stop offset="100%" stopColor="#9177C7" />
          </linearGradient>
        </defs>
        <path d={siGooglegemini.path} fill="url(#gl-gem)" />
      </svg>
    );
  }
  if (family === "gpt-image-2" || /gpt|openai/i.test(name)) {
    // Six petals at 60° — the knot silhouette, in the familiar green.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <g fill="none" stroke="#10A37F" strokeWidth="2.1" strokeLinecap="round">
          {[0, 60, 120, 180, 240, 300].map((r) => (
            <path key={r} transform={`rotate(${r} 12 12)`} d="M12 3.2 A 5.4 5.4 0 0 1 17.4 8.6 L 17.4 12" />
          ))}
        </g>
      </svg>
    );
  }
  if (/flux/i.test(name)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 3 2.5 19.5h19z" opacity=".35" />
        <path d="M12 8.5 6.3 18.3h11.4z" opacity=".7" />
        <path d="M12 13.4 9.6 17.6h4.8z" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="5.5" fill="currentColor" opacity="0.5" />
    </svg>
  );
}
