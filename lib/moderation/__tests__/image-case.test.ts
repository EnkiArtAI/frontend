import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash, randomBytes } from "crypto";
import sharp from "sharp";
import { fakePostgrest } from "@/lib/__tests__/_fake-postgrest";

/**
 * A suspected child-safety image (Kev, 2026-10-08): kept privately and
 * encrypted as evidence, one pending case a human decides, a mail to the
 * admins, and never an automatic sanction.
 */

const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/admin-notify", () => ({ notifyAdmins: notify }));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserWithBan: async (_s: unknown, token: string) => ({ userId: token === "tok" ? "user-1" : null, ban: null, wallet: null }),
}));

import { recordImageCase, readImageEvidence, EVIDENCE_BUCKET } from "@/lib/moderation/image-case";

let db: ReturnType<typeof fakePostgrest>;
let files: Map<string, Buffer>;
let buckets: Map<string, { public: boolean }>;
let uploadFails: boolean;
let bucketUnread: boolean;
let client: unknown;
const req = (headers: Record<string, string> = { "X-Session-Token": "tok", "x-forwarded-for": "1.2.3.4" }) =>
  ({ headers: { get: (n: string) => headers[n] ?? headers[n.toLowerCase()] ?? null } });

let png: Buffer;
beforeEach(async () => {
  process.env.FIELD_ENCRYPTION_KEY_B64 = randomBytes(32).toString("base64");
  process.env.AUTH_PEPPER = "test-pepper"; // hashIp records nothing without it
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 0, b: 0 } } }).png().toBuffer();
  db = fakePostgrest();
  db.tables.automod_events = [];
  db.tables.bans = [];
  files = new Map();
  buckets = new Map();
  uploadFails = false;
  bucketUnread = false;
  notify.mockClear();
  client = {
    from: (t: string) => (db.client as { from: (t: string) => unknown }).from(t),
    storage: {
      createBucket: async (name: string, o: { public: boolean }) => { if (!buckets.has(name)) buckets.set(name, o); return { error: null }; },
      getBucket: async (name: string) => (buckets.has(name) && !bucketUnread ? { data: { id: name, ...buckets.get(name) }, error: null } : { data: null, error: { message: "not found" } }),
      from: (bucket: string) => ({
        upload: async (path: string, body: Buffer) => {
          if (uploadFails) return { error: { message: "storage down" } };
          files.set(`${bucket}/${path}`, Buffer.from(body));
          return { error: null };
        },
        download: async (path: string) => {
          const f = files.get(`${bucket}/${path}`);
          return f ? { data: new Blob([new Uint8Array(f)]), error: null } : { data: null, error: { message: "not found" } };
        },
      }),
    },
  };
});

/** A data: URL's size and its first and last pixel. */
const pixels = async (url: string) => {
  const { data, info } = await sharp(Buffer.from(url.split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
  const at = (i: number) => [...data.subarray(i * info.channels, i * info.channels + 3)].map((c) => Math.round(c / 10) * 10);
  return { width: info.width, height: info.height, first: at(0), last: at(info.width * info.height - 1) };
};

const record = (over: Partial<Parameters<typeof recordImageCase>[1]> = {}) =>
  recordImageCase(client as never, { surface: "generate-image", request: req(), bytes: png, scores: { sexual: 0.4, minor: 0.9 }, about: "inputs: {...}", ...over });

describe("a child-safety image", () => {
  it("becomes one pending child-safety case an admin decides, with the judges' numbers", async () => {
    await record();
    expect(db.tables.automod_events).toEqual([expect.objectContaining({
      user_id: "user-1", surface: "generate-image", decision: "block", severity: "review", tier: 2,
      category: "csam", matched_rules: ["image-check"], scores: { sexual: 0.4, minor: 0.9 },
      prompt_hash: createHash("sha256").update(png).digest("hex"), review_state: "pending",
    })]);
  });

  it("is never a sanction: no ban, no warning weight", async () => {
    await record();
    expect(db.tables.bans).toEqual([]);
    expect(db.tables.automod_events[0].severity).not.toBe("strike");
  });

  it("is kept privately, encrypted under its own case, and opens for the reveal", async () => {
    await record();
    const id = String(db.tables.automod_events[0].id);
    expect(buckets.get(EVIDENCE_BUCKET)).toEqual({ public: false });
    const stored = files.get(`${EVIDENCE_BUCKET}/${id}.json`)!;
    expect(stored.includes(png.toString("base64"))).toBe(false);
    const shown = await readImageEvidence(client as never, id);
    expect(shown?.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(await pixels(shown!)).toMatchObject({ width: 8, height: 8, first: [200, 0, 0] });
  });

  it("opens as the judges saw it, whatever the kept copy's format: one JPEG view", async () => {
    for (const format of ["jpeg", "webp", "gif"] as const) {
      db.tables.automod_events = [];
      await record({ bytes: await sharp(png)[format]().toBuffer() });
      const shown = await readImageEvidence(client as never, String(db.tables.automod_events[0].id));
      expect(shown?.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(await pixels(shown!)).toMatchObject({ width: 8, height: 8 });
    }
  });

  it("opens at most 1024 px wide, so a 2K original fits an answer (capped at 4.5 MB)", async () => {
    const raw = Buffer.from(Array.from({ length: 2048 * 2048 * 3 }, (_, i) => (i * 7919) % 251));
    await record({ bytes: await sharp(raw, { raw: { width: 2048, height: 2048, channels: 3 } }).png().toBuffer() });
    const shown = (await readImageEvidence(client as never, String(db.tables.automod_events[0].id)))!;
    expect(await pixels(shown)).toMatchObject({ width: 1024, height: 1024 });
    expect(shown.length).toBeLessThan(3 * 1024 * 1024);
  });

  it("opens a transparent copy on black and on white, side by side, as the judges saw it", async () => {
    const ink = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    await record({ bytes: ink });
    const shown = await pixels((await readImageEvidence(client as never, String(db.tables.automod_events[0].id)))!);
    expect(shown).toMatchObject({ width: 8 + 8 + 8, height: 8 });
    expect(shown.first).toEqual([0, 0, 0]);
    expect(shown.last.every((c) => c >= 250)).toBe(true);
  });

  it("does not open under another case's id", async () => {
    await record();
    const id = String(db.tables.automod_events[0].id);
    files.set(`${EVIDENCE_BUCKET}/other.json`, files.get(`${EVIDENCE_BUCKET}/${id}.json`)!);
    expect(await readImageEvidence(client as never, "other")).toBeNull();
  });

  it("keeps nothing in an evidence bucket someone made public", async () => {
    buckets.set(EVIDENCE_BUCKET, { public: true });
    await record();
    expect([...files.keys()]).toEqual([]);
    expect(db.tables.automod_events).toHaveLength(1);
    expect(((notify.mock.calls[0] as unknown[])[1] as { text: string }).text).toContain("The private copy could NOT be kept.");
  });

  it("keeps nothing when the bucket's privacy cannot be read", async () => {
    bucketUnread = true;
    await record();
    expect([...files.keys()]).toEqual([]);
    expect(db.tables.automod_events).toHaveLength(1);
  });

  it("still becomes a case when the copy cannot be kept, and the mail says so", async () => {
    uploadFails = true;
    await record();
    expect(db.tables.automod_events).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const mail = (notify.mock.calls[0] as unknown[])[1] as { subject: string; text: string };
    expect(mail.text).toContain("could NOT be kept");
  });

  it("mails the admins without a link or the image", async () => {
    await record();
    const mail = (notify.mock.calls[0] as unknown[])[1] as { subject: string; text: string };
    expect(mail.subject).toBe("Child-safety image held for review: account user-1");
    expect(mail.text).not.toMatch(/https?:|data:/);
    expect(mail.text).toContain("no sanction was applied");
    expect(mail.text).toContain(`Case ${db.tables.automod_events[0].id} waits in the admin People list`);
    // An agent's payment settles before its render is judged.
    expect(mail.text).not.toMatch(/charged/);
  });

  it("says so when the case itself could not be recorded, and where its copy is", async () => {
    const real = (client as { from: (t: string) => unknown }).from;
    (client as { from: unknown }).from = (t: string) => (t === "automod_events" ? { insert: async () => ({ error: { message: "db down" } }) } : real(t));
    await record();
    const mail = (notify.mock.calls[0] as unknown[])[1] as { subject: string; text: string };
    expect(mail.text).toMatch(/The case could NOT be recorded \(see the server log\), so it is not in the admin People list\. Its copy is moderation-evidence\/[0-9a-f-]{36}\.json\./);
    expect(mail.text).not.toContain("waits in the admin People list");
    uploadFails = true;
    notify.mockClear();
    await record();
    expect(((notify.mock.calls[0] as unknown[])[1] as { text: string }).text).toMatch(/so it is not in the admin People list\.$/m);
  });

  it("goes by address on the agent rail, whatever session rides along", async () => {
    await record({ byAddress: true });
    expect(db.tables.automod_events[0].user_id).toBeNull();
    expect(db.tables.automod_events[0].ip_hash).toEqual(expect.any(String));
  });
});
