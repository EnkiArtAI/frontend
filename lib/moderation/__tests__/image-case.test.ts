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
  notify.mockClear();
  client = {
    from: (t: string) => (db.client as { from: (t: string) => unknown }).from(t),
    storage: {
      createBucket: async (name: string, o: { public: boolean }) => { if (!buckets.has(name)) buckets.set(name, o); return { error: null }; },
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
    expect(await readImageEvidence(client as never, id)).toBe(`data:image/png;base64,${png.toString("base64")}`);
  });

  it("does not open under another case's id", async () => {
    await record();
    const id = String(db.tables.automod_events[0].id);
    files.set(`${EVIDENCE_BUCKET}/other.json`, files.get(`${EVIDENCE_BUCKET}/${id}.json`)!);
    expect(await readImageEvidence(client as never, "other")).toBeNull();
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
  });

  it("goes by address on the agent rail, whatever session rides along", async () => {
    await record({ byAddress: true });
    expect(db.tables.automod_events[0].user_id).toBeNull();
    expect(db.tables.automod_events[0].ip_hash).toEqual(expect.any(String));
  });
});
