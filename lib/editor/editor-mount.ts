/**
 * Which editor /editor shows (app/editor/page.tsx keys it by `n`, so a new
 * `n` is a fresh editor). Another ?id= is another prompt, but the id an
 * editor gives itself on its first release keeps it (R13). Another account
 * gets a fresh editor too: drafts and jobs are per account (R15), and one
 * editor carrying the last account's would save them under the new one's
 * key. Signing in, or out and back in as the same account, keeps it.
 */
/**
 * Whose editor, drafts and jobs these are: the account, as long as it is
 * known, and the wallet key only without one. The wallet key comes and goes
 * with the wallet's connection: after a reload it is gone until the wallet is
 * asked to sign. Keyed by it, one person was two "accounts": the session's
 * first payment connected the wallet, the editor took that for another
 * account and started afresh, the inputs and the running render gone (Kev,
 * 2026-10-13).
 */
export const editorOwner = (userId: string | null, userKey: string | null): string | null =>
  userId ? "account:" + userId : userKey;

export interface EditorMount {
  id: string | null;
  n: number;
  /** The id this editor's first release gave it. */
  own: string | null;
  /** The last account seen (editorOwner). */
  user: string | null;
}

/** The mount for this id and account; the same object when nothing changes. */
export function editorMount(m: EditorMount, id: string | null, user: string | null): EditorMount {
  const switched = user !== null && m.user !== null && user !== m.user;
  if (m.id === id && !switched && (user ?? m.user) === m.user) return m;
  const moved = m.id !== id && !(id !== null && id === m.own);
  return { id, n: moved || switched ? m.n + 1 : m.n, own: m.id === id ? m.own : null, user: user ?? m.user };
}
