import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Avatar and cover and the image check (Kev, 2026-10-08): both are judged
 * before either is stored. A profile image is public everywhere and has no
 * 18+ mark, so only a clear one is taken; a child-safety verdict becomes a
 * case an admin decides.
 */

const judged = vi.hoisted(() => ({ verdicts: [] as string[], calls: 0, cases: [] as unknown[], uploads: [] as string[], updates: [] as unknown[] }));
vi.mock("@/lib/moderation/image-check-bytes", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/image-check-bytes")>()),
  checkImageBytes: async () => ({ verdict: judged.verdicts[judged.calls++] ?? "clear" }),
}));
vi.mock("@/lib/moderation/image-case", () => ({ recordImageCase: async (_s: unknown, c: unknown) => { judged.cases.push(c); } }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => "user-1" }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (p: unknown) => p }));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    storage: {
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload: async (path: string) => { judged.uploads.push(path); return { error: null }; },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
      }),
    },
    from: () => ({
      update: (u: unknown) => {
        judged.updates.push(u);
        const q = { eq: () => q, select: () => q, maybeSingle: async () => ({ data: { handle: "h", bio: null, avatar_url: "a", cover_image_url: "c" }, error: null }) };
        return q;
      },
    }),
  }),
}));

import { POST } from "../../app/api/users/profile/route";

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" });
const save = async (files: Record<string, File>) => {
  const form = new FormData();
  for (const [k, f] of Object.entries(files)) form.append(k, f);
  const res = await POST(new Request("http://x/api/users/profile", { method: "POST", headers: { "X-Session-Token": "t", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` }, body: form }) as unknown as NextRequest);
  return { status: res.status, body: (await res.json()) as { error?: string } };
};

beforeEach(() => Object.assign(judged, { verdicts: [], calls: 0, cases: [], uploads: [], updates: [] }));

describe("a profile image", () => {
  it("clear: both are stored and saved", async () => {
    expect((await save({ avatar: png(), cover: png() })).status).toBe(200);
    expect(judged.uploads).toHaveLength(2);
    expect(judged.updates).toEqual([expect.objectContaining({ avatar_url: expect.stringContaining("user-1/avatar-"), cover_image_url: expect.stringContaining("user-1/cover-") })]);
  });

  it("18+: refused, since a profile image has no 18+ mark", async () => {
    judged.verdicts = ["adult"];
    expect(await save({ avatar: png() })).toEqual({ status: 422, body: { error: "A profile picture or cover can't be 18+ on Enki." } });
    expect(judged.uploads).toEqual([]);
    expect(judged.updates).toEqual([]);
  });

  it("a refused cover keeps the clear avatar from being stored as well", async () => {
    judged.verdicts = ["clear", "blocked"];
    expect(await save({ avatar: png(), cover: png() })).toEqual({ status: 422, body: { error: "This image can't be uploaded to Enki." } });
    expect(judged.uploads).toEqual([]);
  });

  it("child safety: refused like any refusal, and a case with the bytes", async () => {
    judged.verdicts = ["child_safety"];
    expect((await save({ cover: png() })).status).toBe(422);
    expect(judged.cases).toEqual([expect.objectContaining({ surface: "profile", bytes: Buffer.from([137, 80, 78, 71]), about: "A cover image." })]);
    expect(judged.uploads).toEqual([]);
  });

  it("not judged: not stored, try again", async () => {
    judged.verdicts = ["unavailable"];
    expect((await save({ avatar: png() })).status).toBe(503);
    expect(judged.uploads).toEqual([]);
  });

  it("a file that is no PNG, JPG or WebP is turned away before any check is paid for", async () => {
    const res = await save({ avatar: new File([new Uint8Array([1])], "a.gif", { type: "image/gif" }) });
    expect(res).toEqual({ status: 400, body: { error: "Use a PNG, JPG or WebP image" } });
    expect(judged.calls).toBe(0);
  });
});
