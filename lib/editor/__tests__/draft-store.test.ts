import { describe, it, expect } from "vitest";
import { draftStore, draftKey, browserBackend, type Draft, type DraftBackend } from "../draft-store";
import type { EditorSetup } from "../generate-checks";
import type { Job } from "@/lib/ui/kit/render-queue";

function fake() {
  const text = new Map<string, string>();
  const blobs = new Map<string, unknown>();
  const backend: DraftBackend = {
    text: { getItem: (k) => text.get(k) ?? null, setItem: (k, v) => void text.set(k, v), removeItem: (k) => void text.delete(k) },
    blobs: { get: async (k) => blobs.get(k), set: async (k, v) => void blobs.set(k, v), del: async (k) => void blobs.delete(k) },
  };
  return { text, blobs, backend };
}

const draft: Draft = {
  doc: { prompt: "a [x]", vars: { x: "1" }, kinds: {}, aiNames: [], refIds: ["r1"] },
  listing: { title: "T", mode: "free", price: 0.07, category: null, primaryId: null, testId: null },
  picks: { ratio: "4:5", resolution: "2K", boost: false },
  stars: { j1: 5 },
  order: ["a [x]"],
};
const job: Job<EditorSetup> = {
  id: "j1", createdAt: 1, status: "ready", imageUrl: "https://x/j1.webp", seen: true,
  setup: { prompt: "a [x]", vars: { x: "1" }, kinds: {}, refIds: ["r1"], modelId: "m", modelName: "M", ratio: "4:5", resolution: "2K", boost: false },
};
const ref = { data: "data:image/webp;base64,AA", stored: null, state: "ready" as const };

describe("draftKey", () => {
  it("is per account and per prompt (R15)", () => {
    expect(draftKey("wallet1", null)).toBe("enki-prompt-editor:v1:wallet1:new");
    expect(draftKey("wallet1", "0b5f6c1e")).toBe("enki-prompt-editor:v1:wallet1:0b5f6c1e");
  });
});

describe("draftStore", () => {
  it("keeps the draft in text storage and the jobs and references in blob storage, under that key", async () => {
    const f = fake();
    const s = draftStore(f.backend, "wallet1", null);
    s.save(draft);
    s.jobs.save([job]);
    s.saveRefs({ r1: ref });
    expect(JSON.parse(f.text.get("enki-prompt-editor:v1:wallet1:new") ?? "null")).toEqual(draft);
    expect([...f.blobs.keys()]).toEqual(["enki-prompt-editor:v1:wallet1:new:jobs", "enki-prompt-editor:v1:wallet1:new:refs"]);
    const again = draftStore(f.backend, "wallet1", null);
    expect(again.load()).toEqual(draft);
    expect(await again.jobs.load()).toEqual([job]);
    expect(await again.loadRefs()).toEqual({ r1: ref });
  });

  it("never shows one account's draft to another, nor one prompt's to another", async () => {
    const f = fake();
    const first = draftStore(f.backend, "wallet1", null);
    first.save(draft);
    first.jobs.save([job]);
    first.saveRefs({ r1: ref });
    for (const other of [draftStore(f.backend, "wallet2", null), draftStore(f.backend, "wallet1", "0b5f6c1e")]) {
      expect(other.load()).toBeNull();
      expect(await other.jobs.load()).toEqual([]);
      expect(await other.loadRefs()).toEqual({});
    }
  });

  it("keeps nothing for no account", async () => {
    const f = fake();
    const s = draftStore(f.backend, null, null);
    s.save(draft);
    s.jobs.save([job]);
    s.saveRefs({ r1: ref });
    expect([f.text.size, f.blobs.size]).toEqual([0, 0]);
    expect(s.load()).toBeNull();
    expect(await s.jobs.load()).toEqual([]);
  });

  it("clear forgets the draft, its jobs and its references", async () => {
    const f = fake();
    const s = draftStore(f.backend, "wallet1", null);
    s.save(draft);
    s.jobs.save([job]);
    s.saveRefs({ r1: ref });
    draftStore(f.backend, "wallet2", null).save(draft);
    s.clear();
    await Promise.resolve();
    expect([...f.text.keys()]).toEqual(["enki-prompt-editor:v1:wallet2:new"]);
    expect(f.blobs.size).toBe(0);
  });

  it("reads a stored reference in again after a reload, and drops one with nothing left", async () => {
    const f = fake();
    const s = draftStore(f.backend, "wallet1", null);
    s.saveRefs({
      ready: ref,
      stored: { data: null, stored: "https://blob/r.webp", state: "failed" },
      both: { data: "data:x", stored: "https://blob/b.webp", state: "loading" },
      gone: { data: null, stored: null, state: "failed" },
    });
    expect(await s.loadRefs()).toEqual({
      ready: ref,
      stored: { data: null, stored: "https://blob/r.webp", state: "loading" },
      both: { data: "data:x", stored: "https://blob/b.webp", state: "ready" },
    });
  });

  it("works on when storage is missing, throws, or holds something else", async () => {
    const broken: DraftBackend = {
      text: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("blocked"); } },
      blobs: { get: () => { throw new Error("no db"); }, set: () => Promise.reject(new Error("full")), del: () => Promise.reject(new Error("no db")) },
    };
    const s = draftStore(broken, "wallet1", null);
    expect(() => [s.save(draft), s.jobs.save([job]), s.saveRefs({}), s.clear()]).not.toThrow();
    expect(s.load()).toBeNull();
    expect(await s.jobs.load()).toEqual([]);
    expect(await s.loadRefs()).toEqual({});
    expect(draftStore({ text: null, blobs: null }, "wallet1", null).load()).toBeNull();

    const f = fake();
    const key = draftKey("wallet1", null);
    for (const junk of ["{not json", JSON.stringify({ doc: {} }), "7"]) {
      f.text.set(key, junk);
      expect(draftStore(f.backend, "wallet1", null).load()).toBeNull();
    }
    f.blobs.set(`${key}:jobs`, { not: "a list" });
    f.blobs.set(`${key}:refs`, "nope");
    expect(await draftStore(f.backend, "wallet1", null).jobs.load()).toEqual([]);
    expect(await draftStore(f.backend, "wallet1", null).loadRefs()).toEqual({});
  });

  it("browserBackend has no storage outside a browser, and does not throw", () => {
    expect(browserBackend()).toEqual({ text: null, blobs: null });
  });
});
