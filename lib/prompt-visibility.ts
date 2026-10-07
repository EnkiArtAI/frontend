/**
 * Who may read a prompt's text.
 *
 * A prompt's body is its creator's secret unless the creator published it as
 * free. A paid prompt's buyers pay for generations from it and see only its
 * variables; a create-now draft belongs to nobody else. The body is encrypted
 * at rest, and only a prompt that passes here may also carry the plaintext
 * excerpt (prompts.public_prompt_text) or show its text to anyone but its
 * creator. Every route that hands out prompt text asks this one question.
 */
export function isPublicText(row: { prompt_type?: unknown; is_free_showcase?: unknown }): boolean {
  return row.is_free_showcase === true || row.prompt_type === "free" || row.prompt_type === "showcase";
}

/** Live on the marketplace: what a non-owner may be shown at all. */
export function isListed(row: { is_listed?: unknown; listing_status?: unknown; deleted_at?: unknown }): boolean {
  return row.is_listed === true && row.listing_status === "active" && !row.deleted_at;
}
