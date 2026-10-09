/**
 * Which editor /editor shows (app/editor/page.tsx keys it by `n`, so a new
 * `n` is a fresh editor). Another ?id= is another prompt, but the id an
 * editor gives itself on its first release keeps it (R13). Another account
 * gets a fresh editor too: drafts and jobs are per account (R15), and one
 * editor carrying the last account's would save them under the new one's
 * key. Signing in, or out and back in as the same account, keeps it.
 */
export interface EditorMount {
  id: string | null;
  n: number;
  /** The id this editor's first release gave it. */
  own: string | null;
  /** The last account seen (useViewerWallets userKey). */
  user: string | null;
}

/** The mount for this id and account; the same object when nothing changes. */
export function editorMount(m: EditorMount, id: string | null, user: string | null): EditorMount {
  const switched = user !== null && m.user !== null && user !== m.user;
  if (m.id === id && !switched && (user ?? m.user) === m.user) return m;
  const moved = m.id !== id && !(id !== null && id === m.own);
  return { id, n: moved || switched ? m.n + 1 : m.n, own: m.id === id ? m.own : null, user: user ?? m.user };
}
