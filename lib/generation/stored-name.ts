/**
 * How app/api/prompt names a [slot] in the database. No imports, so the
 * editor in the browser can warn about two slots that would share a name.
 */

/** The slug app/api/prompt stores a variable name as (chk_var_name_format). */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * The name app/api/prompt's toDbVarName saved a slot under, before its
 * tie-breaks: the slug, with "v_" in front when it does not start with a
 * letter ("2nd subject" -> v_2nd_subject). Null when nothing survives the
 * slug (a name with no ASCII letters or digits is saved as var_N, which the
 * slot text cannot be traced back to).
 */
export function storedName(slotText: string): string | null {
  const s = slug(slotText);
  if (!s) return null;
  return /^[a-z]/.test(s) ? s : `v_${s}`;
}
