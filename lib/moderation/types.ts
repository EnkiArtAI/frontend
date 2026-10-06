/**
 * Moderation contract.
 *
 * The single most important idea here: WHAT WE DO TO THE RENDER and WHAT WE DO
 * TO THE ACCOUNT are separate fields. PR #54 conflated them, which is how an
 * ordinary art prompt ("nude girl statue, classical marble") ended up issuing a
 * permanent ban. Blocking is cheap — it costs a user one attempt. Banning is
 * expensive — it costs them their account and us a paying customer. So a regex
 * may set `decision`, but it may never set `enforcement: 'ban'`.
 */

/** What happens to this render. */
export type Decision = "block" | "allow";

/**
 * What happens to the account.
 *  - 'none'   nothing at all (the normal case, even for a blocked prompt)
 *  - 'log'    record it, take no action against the user
 *  - 'review' record it and put it in the human queue — still no punishment
 *  - 'strike' a counted warning (only ever from the AI tier or a human)
 *  - 'ban'    only ever from a human or the council, never from this module
 */
export type Enforcement = "none" | "log" | "review" | "strike" | "ban";

export type Tier = 1 | 2;

export interface Tier1Result {
  blocked: boolean;
  /** Rule ids that fired — server logs only, never sent to a client. */
  matchedRules: string[];
  category: string | null;
  enforcement: Enforcement;
}

export interface ModerationInput {
  prompt: string;
  /** Which endpoint asked. Recorded so we can measure per-surface block rates. */
  surface: "generate-image" | "generate-free" | "upload" | "quote" | "x402-generate";
  /** Chained so a client disconnect cancels the Tier 2 call. */
  signal?: AbortSignal;
  /**
   * The prompt check already judged this text for sexual content: explicit and
   * child-safety requests were refused there, and suggestive ones are allowed
   * for adults and marked 18+. Tier 2 then leaves its plain "sexual" flag to
   * that judgement; sexual/minors and every other category still block.
   */
  adultJudged?: boolean;
}

export interface ModerationVerdict {
  allowed: boolean;
  decision: Decision;
  enforcement: Enforcement;
  tier: Tier | null;
  category: string | null;
  /** Server-only. Never echo these to a caller's client. */
  matchedRules: string[];
  scores: Record<string, number> | null;
  /** True when the AI tier could not be consulted (no key, timeout, HTTP error). */
  tier2Degraded: boolean;
  /** sha256 of the normalised prompt — the only prompt derivative we log in clear. */
  promptHash: string;
  elapsedMs: number;
}

/**
 * The only text a client ever sees for a block. No category, no score, no rule
 * id: anything more turns the endpoint into an oracle an attacker can probe to
 * map the filter.
 */
export const CLIENT_BLOCK_MESSAGE = "Your prompt violates our content guidelines.";
