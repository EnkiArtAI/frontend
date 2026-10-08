import { describe, it, expect } from "vitest";
import { inChunks, IN_CHUNK } from "@/lib/in-chunks";

/** A few hundred uuids in one .in() make a URL the gateway refuses; the lookup goes a slice at a time. */
describe("inChunks", () => {
  it("asks for at most a slice of distinct ids at a time and merges the answers", async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `id-${i}`);
    const asked: string[][] = [];
    const rows = await inChunks([...ids, ...ids.slice(0, 50)], async (chunk) => {
      asked.push(chunk);
      return { data: chunk.map((id) => ({ id })) };
    });
    expect(IN_CHUNK).toBe(150);
    expect(asked.map((c) => c.length)).toEqual([150, 150, 100]);
    expect(rows.map((r) => r.id)).toEqual(ids);
  });

  it("asks nothing for no ids, and reads a failed slice as empty", async () => {
    let calls = 0;
    expect(await inChunks([], async () => { calls++; return { data: [] }; })).toEqual([]);
    expect(calls).toBe(0);
    expect(await inChunks(["a"], async () => ({ data: null }))).toEqual([]);
  });
});
