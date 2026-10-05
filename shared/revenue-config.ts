/**
 * Revenue splits — the ONE place to change percentages. Every UI text derives
 * from these values, so bumping REFERRAL_SHARE_PCT from 50 to 70 here updates
 * the whole app.
 *
 * When payouts become fully server-computed, these move into an app_config DB
 * table (editable from the Admin panel, no deploy needed); the constants then
 * stay as fallbacks.
 */

/** % of each sale that Enki keeps as platform fee. */
export const PLATFORM_FEE_PCT = 10;

/** Referrer's share OF THE PLATFORM FEE (not of the sale) for referred prompts. */
export const REFERRAL_SHARE_PCT = 50;

/**
 * What a premium prompt costs per image until its artist sets a price (Kev,
 * 2026-10-05): the editor starts a premium prompt at this, and a save without
 * a price stores it.
 */
export const DEFAULT_PROMPT_PRICE_USD = 0.07;

/** Hunter's share of the artist's revenue until the original artist claims. */
export const HUNT_SHARE_PCT = 50;
