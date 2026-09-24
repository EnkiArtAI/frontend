/**
 * The one rule for whether a prompt's body is shown in the clear. It decides
 * what GET /api/prompts/[id] decrypts for a viewer and, at publish, whether
 * the body may be matched with the full vocabulary or only the paid rules.
 * Both sides must agree, or a sold body leaks its colours and framing into
 * the search index while the buyer sees a 220 character excerpt.
 *
 * prompt_type is the DATABASE value (create-now | showcase | free | paid).
 */
export function isFreePrompt(row: { prompt_type: string; is_free_showcase?: boolean | null }): boolean {
  return row.prompt_type === "showcase" || row.prompt_type === "free" || row.is_free_showcase === true;
}
