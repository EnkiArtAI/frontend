import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * A workflow saved to the private library and the image check (Kev,
 * 2026-10-08: every image). Each image the workflow carries is judged before
 * it is kept; the library is private, so 18+ stays; one refused saves
 * nothing, and a child-safety one becomes a case.
 */

const s = vi.hoisted(() => ({
  verdicts: [] as Record<string, unknown>[], judged: [] as string[], cases: [] as Record<string, unknown>[],
  rows: [] as Record<string, unknown>[], refuse: false, limits: [] as unknown[][],
}));
vi.mock("@/lib/moderation/image-check-bytes", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/image-check-bytes")>()),
  checkImageBytes: async (b: Buffer) => { s.judged.push(b.toString("base64")); return s.verdicts.shift() ?? { verdict: "clear" }; },
}));
vi.mock("@/lib/moderation/image-case", () => ({ recordImageCase: async (_c: unknown, c: Record<string, unknown>) => { s.cases.push(c); } }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => "user-1" }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (p: unknown) => p }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  checkRequestRateLimit: (...a: unknown[]) => { s.limits.push(a); return s.refuse ? { allowed: false, retryAfterSeconds: 9 } : { allowed: true }; },
}));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: () => {
      let row: Record<string, unknown> = {};
      const q = {
        insert: (r: Record<string, unknown>) => { row = r; s.rows.push(r); return q; },
        select: () => q,
        single: async () => ({ data: { id: "w-1", ...row }, error: null }),
      };
      return q;
    },
  }),
}));

import { POST } from "../../app/api/library/route";

// Images as the editor exports them: data URLs, long enough to count as images.
const img = (n: number) => `data:image/png;base64,${"iVBORw0KGgo".padEnd(80, "A")}${String(n).padStart(4, "0")}`;
const payload = (n: number) => img(n).split(",")[1];
const save = (graph: unknown) => POST(new NextRequest("http://enki.test/api/library", {
  method: "POST", headers: { "X-Session-Token": "t", "Content-Type": "application/json" }, body: JSON.stringify({ name: "flow", graph }),
}));
const graphOf = (...images: string[]) => ({ nodes: images.map((src, i) => ({ id: `n${i}`, image: src })) });

beforeEach(() => Object.assign(s, { verdicts: [], judged: [], cases: [], rows: [], refuse: false, limits: [] }));

describe("a workflow saved to the library", () => {
  it("without images: saved, nothing judged, no limit spent", async () => {
    expect((await save({ nodes: [{ id: "n", text: "a fox" }] })).status).toBe(201);
    expect(s.judged).toEqual([]);
    expect(s.limits).toEqual([]);
  });

  it("clear and 18+: saved, each image judged once by its bytes, a link never", async () => {
    s.verdicts = [{ verdict: "clear" }, { verdict: "adult", reason: "suggestive" }];
    const res = await save(graphOf(img(1), img(2), img(1), "https://abc.public.blob.vercel-storage.com/x.png"));
    expect(res.status).toBe(201);
    expect(s.judged).toEqual([Buffer.from(payload(1), "base64").toString("base64"), Buffer.from(payload(2), "base64").toString("base64")]);
    expect(s.rows).toHaveLength(1);
    expect(s.limits).toEqual([["library-save:user-1", 20, 60_000]]);
  });

  it.each([
    ["refused", { verdict: "blocked", reason: "explicit" }],
    ["no image at all", { verdict: "blocked", reason: "not an image" }],
  ])("%s: nothing saved, and it says so for good", async (_n, verdict) => {
    s.verdicts = [{ verdict: "clear" }, verdict];
    const res = await save(graphOf(img(1), img(2)));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "One of this workflow's images can't be saved on Enki. Nothing was saved." });
    expect(s.rows).toEqual([]);
    expect(s.cases).toEqual([]);
  });

  it("not judged: nothing saved, try again", async () => {
    s.verdicts = [{ verdict: "unavailable", reason: "moderation api 503" }];
    const res = await save(graphOf(img(1)));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "This workflow's images could not be checked right now. Nothing was saved. Please try again." });
    expect(s.rows).toEqual([]);
  });

  it("child safety: nothing saved, and a case with that image's bytes", async () => {
    s.verdicts = [{ verdict: "clear" }, { verdict: "child_safety", scores: { minor: 0.9 } }];
    expect((await save(graphOf(img(1), img(2)))).status).toBe(422);
    expect(s.rows).toEqual([]);
    expect(s.cases).toEqual([expect.objectContaining({ surface: "library", scores: { minor: 0.9 }, bytes: Buffer.from(payload(2), "base64") })]);
  });

  it("judges an image in any spelling a browser shows, at any depth", async () => {
    let deep: unknown = { image: `DATA:Image/PNG;BASE64,${payload(3)}` };
    for (let i = 0; i < 100; i++) deep = { child: deep };
    const res = await save({ nodes: [{ image: `data:application/octet-stream;base64,${payload(1)}` }, { image: ` data:image/png;base64,${payload(2)}` }], deep });
    expect(res.status).toBe(201);
    expect(s.judged).toHaveLength(3);
    expect(s.judged).toEqual(expect.arrayContaining([1, 2, 3].map((n) => Buffer.from(payload(n), "base64").toString("base64"))));
  });

  it("judges a percent-encoded data URL by the bytes a browser reads from it", async () => {
    s.verdicts = [{ verdict: "blocked", reason: "not a still" }];
    const res = await save(graphOf("data:image/svg+xml,%3Csvg%2F%3E"));
    expect(res.status).toBe(422);
    expect(s.judged).toEqual([Buffer.from("<svg/>").toString("base64")]);
    expect(s.rows).toEqual([]);
  });

  it("judges what the URL parser reads as a data URL: controls around it, line breaks within", async () => {
    const res = await save(graphOf(`\u0001data:image/png;base64,${payload(1)}`, `d\ta\nt\ra:image/png;base64,${payload(2)}`));
    expect(res.status).toBe(201);
    expect(s.judged).toEqual([1, 2].map((n) => Buffer.from(payload(n), "base64").toString("base64")));
  });

  it("records a child-safety case with that image's own bytes, text beside it or not", async () => {
    s.verdicts = [{ verdict: "blocked", reason: "not an image" }, { verdict: "child_safety" }];
    expect((await save({ title: "Data: a lab, at night", nodes: [{ image: img(2) }] })).status).toBe(422);
    expect(s.cases).toEqual([expect.objectContaining({ bytes: Buffer.from(payload(2), "base64") })]);
  });

  it("keeps text that only begins like a data URL, and refuses a data URL that claims an image and holds none", async () => {
    const none = { verdict: "blocked", reason: "not an image" };
    s.verdicts = [none, none];
    expect((await save({ title: "Data: a lab, at night", prompt: "data: no comma here" })).status).toBe(201);
    for (const claim of ["data:image/png,garbage", "data:;base64,AAAA"]) {
      s.verdicts = [none];
      expect((await save(graphOf(claim))).status, claim).toBe(422);
    }
  });

  it("takes long plain text for text, however much it looks like base64", async () => {
    const prompt = "cinematic portrait of an old fisherman at dawn 85mm lens shallow depth of field ".repeat(5);
    expect(prompt.length).toBeGreaterThan(256);
    expect((await save({ prompt, nodes: [{ value: prompt }] })).status).toBe(201);
    expect(s.judged).toEqual([]);
  });

  it("more than 14 images: refused before any check", async () => {
    const res = await save(graphOf(...Array.from({ length: 15 }, (_, i) => img(i))));
    expect(res.status).toBe(422);
    expect(s.judged).toEqual([]);
    expect(await save(graphOf(...Array.from({ length: 14 }, (_, i) => img(i))))).toMatchObject({ status: 201 });
  });

  it("over the limit: refused before any check", async () => {
    s.refuse = true;
    const res = await save(graphOf(img(1)));
    expect(res.status).toBe(429);
    expect(s.judged).toEqual([]);
    expect(s.rows).toEqual([]);
  });
});
