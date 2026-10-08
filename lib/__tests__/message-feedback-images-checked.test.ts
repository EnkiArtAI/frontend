import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Images in direct messages and feedback reports and the image check (Kev,
 * 2026-10-08: every image). A message has no 18+ mark and can reach anyone,
 * so only a clear image is sent. A feedback attachment is for the admins
 * alone: 18+ stays, an image refused or not judged is dropped while the
 * report stands. A child-safety verdict becomes a case on either.
 */

const s = vi.hoisted(() => ({ verdicts: [] as string[], calls: 0, cases: [] as unknown[], uploads: [] as string[], rows: [] as { table: string; row: unknown }[] }));
// As the real check: bytes no decoder reads never reach the judges (here,
// anything but a PNG or an AVIF, which opens like an MP4, and a JPEG cut
// short reads as one that does not decode whole); `calls` counts what the
// judges see.
vi.mock("@/lib/moderation/image-check-bytes", async (orig) => {
  const real = await orig<typeof import("@/lib/moderation/image-check-bytes")>();
  return {
    ...real,
    checkImageBytes: async (b: Buffer) =>
      b.subarray(0, 4).toString("hex") === "89504e47" || b.toString("latin1", 4, 12) === "ftypavif" ? { verdict: s.verdicts[s.calls++] ?? "clear" }
      : b.subarray(0, 2).toString("hex") === "ffd8" ? { verdict: "blocked", reason: "unreadable" }
      : { verdict: "blocked", reason: real.NOT_AN_IMAGE },
  };
});
vi.mock("@/lib/moderation/image-case", () => ({ recordImageCase: async (_c: unknown, c: unknown) => { s.cases.push(c); } }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => "user-1" }));
// The limits have their own tests; here one account sends more reports than they allow.
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  checkRequestRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (p: unknown) => p }));
vi.mock("@/lib/crypto", () => ({ encryptString: () => ({ encrypted: "ct", iv: "iv", authTag: "tag", kid: "k" }), decryptString: () => "" }));
vi.mock("@/lib/dm", async (orig) => ({
  ...(await orig<typeof import("@/lib/dm")>()),
  loadThreadFor: async () => ({ id: "t", a_id: "user-1", b_id: "user-2" }),
  shapeMessages: async (_c: unknown, rows: unknown[]) => rows,
}));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => {
    const query = (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "update"]) q[m] = () => q;
      q.insert = (row: unknown) => { s.rows.push({ table, row }); return q; };
      q.single = async () => ({ data: { id: "row-1", created_at: "now" }, error: null });
      q.maybeSingle = async () => ({ data: { handle: "h" }, error: null });
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
      return q;
    };
    return {
      from: query,
      storage: {
        createBucket: async () => ({ error: null }),
        from: () => ({ upload: async (path: string) => { s.uploads.push(path); return { error: null }; }, remove: async () => ({ error: null }) }),
      },
    };
  },
}));

import { POST as sendImage } from "../../app/api/messages/image/route";
import { POST as sendFeedback } from "../../app/api/feedback/route";

const THREAD = "11111111-1111-4111-8111-111111111111";
const file = (type = "image/png", name = "a.png") => new File([new Uint8Array([137, 80, 78, 71])], name, { type });
const post = async (handler: (r: NextRequest) => Promise<Response>, fields: Record<string, string | File | File[]>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) form.append(k, one);
  const res = await handler(new Request("http://x/api", { method: "POST", headers: { "X-Session-Token": "t", "x-forwarded-for": `10.1.0.${s.calls}` }, body: form }) as unknown as NextRequest);
  return { status: res.status, body: (await res.json()) as { error?: string } };
};

beforeEach(() => Object.assign(s, { verdicts: [], calls: 0, cases: [], uploads: [], rows: [] }));

describe("an image in a direct message", () => {
  it("clear: stored and sent", async () => {
    expect((await post(sendImage, { threadId: THREAD, file: file() })).status).toBe(201);
    expect(s.uploads).toHaveLength(1);
    expect(s.rows.map((r) => r.table)).toContain("dm_messages");
  });

  it.each([
    ["18+", "adult", 422, "18+ images can't be sent in messages."],
    ["refused", "blocked", 422, "This image can't be uploaded to Enki."],
    ["not judged", "unavailable", 503, "Your image could not be checked right now, so it was not uploaded. Please try again."],
  ])("%s: neither stored nor sent", async (_n, verdict, status, error) => {
    s.verdicts = [verdict];
    expect(await post(sendImage, { threadId: THREAD, file: file() })).toEqual({ status, body: { error } });
    expect(s.uploads).toEqual([]);
    expect(s.rows).toEqual([]);
  });

  it("child safety: neither stored nor sent, and a case with the bytes", async () => {
    s.verdicts = ["child_safety"];
    expect((await post(sendImage, { threadId: THREAD, file: file() })).status).toBe(422);
    expect(s.cases).toEqual([expect.objectContaining({ surface: "dm", bytes: Buffer.from([137, 80, 78, 71]) })]);
    expect(s.uploads).toEqual([]);
  });
});

describe("an image attached to a feedback report", () => {
  const report = (files: File[]) => post(sendFeedback, { description: "The button does nothing at all.", severity: "minor", files });

  it("keeps clear and 18+ ones, drops refused and unjudged ones, and the report stands", async () => {
    s.verdicts = ["clear", "adult", "blocked", "unavailable"];
    expect((await report([file(), file(), file(), file()])).status).toBe(201);
    expect(s.uploads.map((p) => p.split("/")[1].split("-")[0])).toEqual(["0", "1"]);
    expect(s.rows.filter((r) => r.table === "feedback_attachments")).toHaveLength(2);
  });

  it("child safety: dropped, and a case with the bytes", async () => {
    s.verdicts = ["child_safety"];
    expect((await report([file()])).status).toBe(201);
    expect(s.uploads).toEqual([]);
    expect(s.cases).toEqual([expect.objectContaining({ surface: "feedback" })]);
  });

  const bytes = (type: string, b: number[], name = "a.bin") => new File([new Uint8Array(b)], name, { type });
  const MP4 = [0, 0, 0, 0x18, ...Buffer.from("ftypmp42")];
  const WEBM = [0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0];

  it("a video, by its own bytes, is kept unjudged: the check cannot read one", async () => {
    expect((await report([bytes("video/mp4", MP4), bytes("video/quicktime", MP4), bytes("video/webm", WEBM)])).status).toBe(201);
    expect(s.calls).toBe(0);
    expect(s.uploads).toHaveLength(3);
  });

  it("an image labelled a video or a GIF is judged like any", async () => {
    s.verdicts = ["blocked", "blocked"];
    expect((await report([file("video/mp4", "a.mp4"), file("image/gif", "a.gif")])).status).toBe(201);
    expect(s.calls).toBe(2);
    expect(s.uploads).toEqual([]);
  });

  it("an image in a video's container, labelled a video, is judged like any", async () => {
    s.verdicts = ["blocked"];
    expect((await report([bytes("video/mp4", [0, 0, 0, 0x18, ...Buffer.from("ftypavif")])])).status).toBe(201);
    expect(s.calls).toBe(1);
    expect(s.uploads).toEqual([]);
  });

  it("a cut image whose bytes happen to read ftyp, labelled a video, is dropped: a decoder knew it for an image", async () => {
    expect((await report([bytes("video/mp4", [0xff, 0xd8, 0xff, 0xe1, ...Buffer.from("ftyp"), 0, 0])])).status).toBe(201);
    expect(s.uploads).toEqual([]);
  });

  it("drops what is neither an image the check reads nor a declared video", async () => {
    expect((await report([bytes("video/mp4", [1, 2, 3, 4, 5, 6, 7, 8]), bytes("image/gif", MP4)])).status).toBe(201);
    expect(s.uploads).toEqual([]);
  });
});
