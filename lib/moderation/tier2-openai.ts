/**
 * Tier 2 — the AI classifier. This is the layer that actually decides.
 *
 * Why a classifier and not a chat model: `omni-moderation-latest` scores text
 * against fixed categories. It has no instructions to override, so "ignore all
 * previous instructions" does nothing to it. A GPT-as-judge would be a live
 * prompt-injection target; this is not.
 *
 * It is also multilingual, which the word list is not — Tier 1 only understands
 * English, and the product is global.
 *
 * Free endpoint, so there is no per-request cost to weigh.
 *
 * NOT YET ACTIVE: the project has no OpenAI account as of 2026-08-04. Until a
 * key exists this module reports "degraded" and the pipeline falls through to
 * allow — which is exactly why Tier 1 keeps blocking the unambiguous cases on
 * its own in the meantime.
 */
const ENDPOINT = "https://api.openai.com/v1/moderations";
const MODEL = "omni-moderation-latest";
const TIMEOUT_MS = 8000;

/**
 * Thresholds for `sexual/minors`, the one category where we act on the score
 * rather than on the model's own `flagged` boolean.
 *
 * Deliberately NOT tuned to block everything near the topic: a child in a
 * picture is ordinary (children's books, family scenes, illustration). This
 * category fires on SEXUALISED minors, which is the distinction a word list can
 * never make. Blocking on "a child appears" is the Higgsfield failure mode.
 */
const MINORS_REVIEW = 0.3; // below this: allow outright
const MINORS_HIGH = 0.9;   // above this: top-priority human review

export interface Tier2Result {
  blocked: boolean;
  category: string | null;
  /** Never 'ban': a ban is a human decision. High scores raise priority only. */
  enforcement: "none" | "log" | "review";
  priority: "normal" | "high";
  scores: Record<string, number>;
}

function apiKey(): string | null {
  const raw = process.env.OPENAI_API_KEYS || process.env.OPENAI_API_KEY || "";
  const first = raw.split(",")[0]?.trim();
  return first ? first : null;
}

export function isTier2Configured(): boolean {
  return apiKey() !== null;
}

/** Throws on any transport/API failure — the caller decides how to degrade. */
export async function screenTier2(prompt: string, signal?: AbortSignal, adultJudged = false): Promise<Tier2Result> {
  const key = apiKey();
  if (!key) throw new Error("moderation tier 2 not configured");

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: prompt }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`moderation api ${res.status}`);

  const data = (await res.json()) as {
    results?: { flagged?: boolean; categories?: Record<string, boolean>; category_scores?: Record<string, number> }[];
  };
  const result = data.results?.[0];
  if (!result) throw new Error("moderation api returned no result");

  const scores = result.category_scores ?? {};
  const minors = scores["sexual/minors"] ?? 0;

  if (minors >= MINORS_REVIEW) {
    return {
      blocked: true,
      category: "sexual/minors",
      enforcement: "review",
      priority: minors >= MINORS_HIGH ? "high" : "normal",
      scores,
    };
  }

  // Everything else follows OpenAI's own verdict rather than a hand-picked
  // threshold. PR #54 discarded `flagged` entirely and ignored hate, harassment,
  // violence and illicit content.
  // A text the prompt check already judged keeps everything but the plain
  // "sexual" flag: suggestive is allowed for adults there, explicit was refused.
  const flagged = adultJudged
    ? Object.entries(result.categories ?? {}).some(([k, v]) => v === true && k !== "sexual")
    : result.flagged;
  if (flagged) {
    const worst = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return { blocked: true, category: worst?.[0] ?? "flagged", enforcement: "log", priority: "normal", scores };
  }

  return { blocked: false, category: null, enforcement: "none", priority: "normal", scores };
}
