/**
 * Content moderation — the public entry point.
 *
 *   const verdict = await moderate({ prompt, surface: "generate-image", signal });
 *   if (!verdict.allowed) return NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 });
 *
 * Contract: this module performs at most one outbound HTTP call and ZERO
 * database writes. It returns a verdict; recording violations, strikes and
 * bans is the caller's job (lib/moderation-enforcement). That separation keeps
 * it testable without mocking Supabase, and keeps it safe to call from any
 * serverless route.
 *
 * Order matters: Tier 1 runs first and short-circuits. That is deliberate, not
 * an optimisation — text matching an unambiguous CSAM rule never leaves our
 * infrastructure to a third party. The routes also run it alone (screenFirst)
 * before the prompt check, whose chat model would otherwise see the text first.
 */
import { createHash } from "crypto";
import { normaliseForHash } from "./normalize";
import { screenTier1 } from "./tier1";
import { isTier2Configured, screenTier2 } from "./tier2-openai";
import type { ModerationInput, ModerationVerdict } from "./types";

export { CLIENT_BLOCK_MESSAGE } from "./types";
export type { ModerationVerdict, ModerationInput, Decision, Enforcement } from "./types";
export { screenTier1 } from "./tier1";
export { isTier2Configured } from "./tier2-openai";

function baseFor(prompt: string) {
  return {
    matchedRules: [] as string[],
    scores: null as Record<string, number> | null,
    tier2Degraded: false,
    promptHash: createHash("sha256").update(normaliseForHash(prompt)).digest("hex"),
  };
}

/** Tier 1's refusal of this text, or null when no rule matched. */
function tier1Block(prompt: string, started: number): ModerationVerdict | null {
  const t1 = screenTier1(prompt);
  if (!t1.blocked) return null;
  return {
    ...baseFor(prompt),
    allowed: false,
    decision: "block",
    enforcement: t1.enforcement,
    tier: 1,
    category: t1.category,
    matchedRules: t1.matchedRules,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Tier 1 over the text the prompt check would send out, for the routes to run
 * BEFORE that check: text a rule refuses never reaches the chat model, and the
 * refusal is the request's moderation verdict (Kev, 2026-10-06: the regex
 * first, then the LLM). Null when no rule matched.
 */
export function screenFirst(inputs: Record<string, string>): ModerationVerdict | null {
  const text = Object.values(inputs).join("\n");
  return text.trim() ? tier1Block(text, Date.now()) : null;
}

export async function moderate(input: ModerationInput): Promise<ModerationVerdict> {
  const started = Date.now();
  const base = baseFor(input.prompt);

  // Empty or whitespace-only input is not a violation — it is a bad request.
  // PR #54 returned severity null here, which the router coerced to 'strike',
  // so submitting an empty prompt counted toward a ban.
  if (!input.prompt.trim()) {
    return { ...base, allowed: true, decision: "allow", enforcement: "none", tier: null, category: null, elapsedMs: Date.now() - started };
  }

  const t1 = tier1Block(input.prompt, started);
  if (t1) return t1;

  if (!isTier2Configured()) {
    // No AI tier yet. Tier 1 already passed, so allow — and flag the degradation
    // so it shows up in the record rather than looking like a clean pass.
    return { ...base, allowed: true, decision: "allow", enforcement: "none", tier: null, category: null, tier2Degraded: true, elapsedMs: Date.now() - started };
  }

  try {
    const t2 = await screenTier2(input.prompt, input.signal, input.adultJudged === true);
    return {
      ...base,
      allowed: !t2.blocked,
      decision: t2.blocked ? "block" : "allow",
      enforcement: t2.enforcement,
      tier: 2,
      category: t2.category,
      scores: t2.scores,
      elapsedMs: Date.now() - started,
    };
  } catch {
    // Fail open on text, and say so. Failing closed here would take the whole
    // product down on an OpenAI blip, and Tier 1 has already cleared the
    // unambiguous cases. Uploaded IMAGES must fail closed instead — that path
    // is separate and not implemented yet.
    return { ...base, allowed: true, decision: "allow", enforcement: "none", tier: null, category: null, tier2Degraded: true, elapsedMs: Date.now() - started };
  }
}
