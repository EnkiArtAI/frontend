/**
 * Where the Prompt Editor keeps its work in the browser (plan R15; replaces
 * lib/editorVersions.ts). One draft per account and per prompt, under
 * `enki-prompt-editor:v1:<userKey>:<id|new>`: the doc, listing, settings,
 * stars and variation order in localStorage; the jobs and the reference
 * images, which hold large data URLs, in IndexedDB under the same key.
 *
 * The old store kept one draft per browser, so a second account saw the
 * first one's. Signed out, nothing is kept. Storage can be missing, full or
 * blocked: every access is caught and the editor works without it.
 */
import type { JobStore } from "@/hooks/useRenderQueue";
import type { EditorSetup, RenderPicks } from "./generate-checks";
import type { Listing } from "./release";
import type { EditorDoc, RefImage, RefStore } from "./undo";
import type { Stars } from "./variations";

export interface Draft {
  doc: EditorDoc;
  listing: Listing;
  picks: RenderPicks;
  stars: Stars;
  /** Variation keys in the order they first appeared (lib/editor/variations withVariation). */
  order: string[];
}

export interface TextStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BlobStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

/** localStorage and IndexedDB, or stand-ins in a test; null where there is none. */
export interface DraftBackend {
  text: TextStore | null;
  blobs: BlobStore | null;
}

export interface DraftStore {
  load(): Draft | null;
  save(draft: Draft): void;
  /** For useRenderQueue's `persist`; stable as long as the store is. */
  jobs: JobStore<EditorSetup>;
  loadRefs(): Promise<RefStore>;
  saveRefs(refs: RefStore): void;
  /** Forgets this draft, e.g. the "new" one once it is released under an id. */
  clear(): void;
}

export const draftKey = (userKey: string, promptId: string | null) => `enki-prompt-editor:v1:${userKey}:${promptId ?? "new"}`;

const attempt = <T>(read: () => T, otherwise: T): T => {
  try {
    return read();
  } catch {
    return otherwise;
  }
};

/** The draft of `userKey` for `promptId` (null: a new prompt). Without a userKey it keeps nothing. */
export function draftStore({ text, blobs }: DraftBackend, userKey: string | null, promptId: string | null): DraftStore {
  const key = userKey ? draftKey(userKey, promptId) : null;
  /** `op` on this draft's part in the blob store; undefined when there is none or it fails. */
  const blob = async (part: string, op: (b: BlobStore, k: string) => Promise<unknown>) => {
    if (!key || !blobs) return undefined;
    try {
      return await op(blobs, `${key}:${part}`);
    } catch {
      return undefined;
    }
  };
  return {
    load() {
      if (!key || !text) return null;
      const draft = attempt(() => JSON.parse(text.getItem(key) ?? "null") as Draft | null, null);
      return typeof draft?.doc?.prompt === "string" ? draft : null;
    },
    save(draft) {
      if (key && text) attempt(() => text.setItem(key, JSON.stringify(draft)), undefined);
    },
    jobs: {
      load: async () => {
        const jobs = await blob("jobs", (b, k) => b.get(k));
        return Array.isArray(jobs) ? jobs : [];
      },
      save: (jobs) => void blob("jobs", (b, k) => b.set(k, jobs)),
    },
    async loadRefs() {
      const refs = await blob("refs", (b, k) => b.get(k));
      if (!refs) return {};
      // A stored image is read in again after a reload; one with neither data nor a URL is gone.
      return Object.fromEntries(
        Object.entries(refs as RefStore).flatMap(([id, r]): Array<[string, RefImage]> =>
          r?.data ? [[id, { ...r, state: "ready" }]] : r?.stored ? [[id, { data: null, stored: r.stored, state: "loading" }]] : [],
        ),
      );
    },
    saveRefs: (refs) => void blob("refs", (b, k) => b.set(k, refs)),
    clear() {
      if (!key) return;
      attempt(() => text?.removeItem(key), undefined);
      for (const part of ["jobs", "refs"]) void blob(part, (b, k) => b.del(k));
    },
  };
}

const DB = "enki-prompt-editor";
const STORE = "drafts";

/** IndexedDB as a BlobStore, opened on first use; every failure rejects, and the draft store catches it. */
function indexedStore(): BlobStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>) =>
    open().then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const req = op(d.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  return {
    get: (k) => run("readonly", (s) => s.get(k)),
    set: (k, v) => run("readwrite", (s) => s.put(v, k)).then(() => undefined),
    del: (k) => run("readwrite", (s) => s.delete(k)).then(() => undefined),
  };
}

/** The browser's storages; a blocked or missing one is null. */
export function browserBackend(): DraftBackend {
  return {
    text: attempt(() => window.localStorage, null),
    blobs: typeof indexedDB === "undefined" ? null : indexedStore(),
  };
}
