/**
 * The grow-only set behind useGrowOnly (plan R9). Both steps answer the very
 * same Set when nothing changes, so a keystroke that releases a field which
 * was not held does not re-render the form.
 */

export function holdKeys(held: ReadonlySet<string>, keys: readonly string[]): ReadonlySet<string> {
  const next = new Set([...held, ...keys]);
  return next.size === held.size ? held : next;
}

export function releaseKey(held: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!held.has(key)) return held;
  const next = new Set(held);
  next.delete(key);
  return next;
}
