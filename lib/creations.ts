export type StoredCreation = {
  id: string;
  imageUrl: string;
  prompt: string;
  createdAt: string;
};

const STORAGE_PREFIX = "enki:creations:";
const UPDATE_EVENT = "enki:creations_updated";

function getStorageKey(userKey: string) {
  return `${STORAGE_PREFIX}${userKey}`;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Every URL a server gallery row is known by: the original (image_url) and
 * what galleries display (image_urls, the WebP preview when one exists). A
 * render the browser kept under either of them is that row, not a second image.
 */
export function serverUrls(rows: Array<{ image_url?: string | null; image_urls?: string[] | null }>): Set<string> {
  return new Set(
    rows.flatMap((r) => [r.image_url, ...(r.image_urls ?? [])]).filter((u): u is string => typeof u === "string" && u !== ""),
  );
}

/**
 * Get user key from Thirdweb account
 */
export function getUserKeyFromAccount(account: { address: string } | null | undefined): string | null {
  if (!account?.address) return null;
  return account.address;
}

/**
 * @deprecated Use getUserKeyFromAccount instead
 * Kept for backward compatibility during migration
 */
export function getUserKeyFromPrivyUser(user: unknown): string | null {
  const u = user as any;
  if (!u) return null;
  // Try to extract wallet address if it's a Thirdweb account-like object
  if (u.address) return u.address;
  return (
    u.id ||
    u.userId ||
    u?.wallet?.address ||
    u?.email?.address ||
    u?.google?.email ||
    null
  );
}

export function listCreations(userKey: string): StoredCreation[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(getStorageKey(userKey));
  const items = safeParse<StoredCreation[]>(raw, []);
  return Array.isArray(items) ? items : [];
}

export function addCreation(userKey: string, creation: StoredCreation): void {
  if (typeof window === "undefined") return;
  const key = getStorageKey(userKey);
  const existing = listCreations(userKey);
  const next = [creation, ...existing];
  window.localStorage.setItem(key, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: { userKey } }));
}

export function removeCreation(userKey: string, id: string): void {
  if (typeof window === "undefined") return;
  const key = getStorageKey(userKey);
  const next = listCreations(userKey).filter((c) => c.id !== id);
  window.localStorage.setItem(key, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: { userKey } }));
}

export function clearCreations(userKey: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(getStorageKey(userKey));
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: { userKey } }));
}

export function subscribeCreations(
  userKey: string,
  onChange: (items: StoredCreation[]) => void
): () => void {
  if (typeof window === "undefined") return () => {};

  const handler = (e: Event) => {
    const ce = e as CustomEvent<{ userKey?: string }>;
    if (ce?.detail?.userKey && ce.detail.userKey !== userKey) return;
    onChange(listCreations(userKey));
  };

  const storageHandler = (e: StorageEvent) => {
    if (e.key !== getStorageKey(userKey)) return;
    onChange(listCreations(userKey));
  };

  window.addEventListener(UPDATE_EVENT, handler as EventListener);
  window.addEventListener("storage", storageHandler);
  return () => {
    window.removeEventListener(UPDATE_EVENT, handler as EventListener);
    window.removeEventListener("storage", storageHandler);
  };
}
