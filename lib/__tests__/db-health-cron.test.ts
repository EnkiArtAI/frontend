import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * ENG-08. A database outage reaches a human exactly once, its end exactly
 * once, and neither the recipients nor the "already told" state live in the
 * database that is down.
 */

let dbUp = true;
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => {
    const q = {
      from: () => q, select: () => q, limit: () => q,
      abortSignal: async () => (dbUp ? { data: [], error: null } : { data: null, error: { message: "TypeError: fetch failed" } }),
    };
    return q;
  },
}));

let mailWorks = true;
const mails: { to: string; subject: string }[] = [];
vi.mock("@/lib/mailer", () => ({
  sendMail: async (m: { to: string; subject: string }) => {
    if (!mailWorks) return { ok: false };
    mails.push(m);
    return { ok: true };
  },
}));

const store = new Map<string, Date>();
vi.mock("@vercel/blob", () => ({
  list: async ({ prefix }: { prefix: string }) => ({
    blobs: [...store].filter(([p]) => p.startsWith(prefix)).map(([pathname, uploadedAt]) => ({ pathname, uploadedAt, url: `https://blob.test/${pathname}` })),
  }),
  put: async (pathname: string) => { store.set(pathname, new Date()); return { url: `https://blob.test/${pathname}` }; },
  del: async (url: string) => { store.delete(url.replace("https://blob.test/", "")); },
}));

import { GET } from "../../app/api/cron/db-health/route";

const run = () => GET(new NextRequest("http://enki.test/api/cron/db-health", { headers: { authorization: "Bearer cron-secret" } }));

beforeEach(() => {
  dbUp = true;
  mailWorks = true;
  mails.length = 0;
  store.clear();
  process.env.CRON_SECRET = "cron-secret";
  process.env.OPS_ALERT_EMAILS = "ops@enki.test, kev@enki.test";
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test";
  process.env.RESEND_API_KEY = "re_test";
  process.env.SUPABASE_URL = "https://db.enki.test";
});

describe("the database outage alert", () => {
  it("says nothing while the database answers", async () => {
    await run();
    await run();
    expect(mails).toEqual([]);
  });

  it("mails every recipient once when it stops, once when it is back", async () => {
    dbUp = false;
    await run();
    expect(mails.map((m) => [m.to, m.subject])).toEqual([
      ["ops@enki.test", "Enki: database unreachable"],
      ["kev@enki.test", "Enki: database unreachable"],
    ]);
    await run();
    await run();
    expect(mails).toHaveLength(2);

    dbUp = true;
    await run();
    expect(mails.slice(2).map((m) => m.subject)).toEqual(["Enki: database back", "Enki: database back"]);
    await run();
    expect(mails).toHaveLength(4);
  });

  it("retries an alert that could not be sent", async () => {
    dbUp = false;
    mailWorks = false;
    await run();
    mailWorks = true;
    await run();
    expect(mails.map((m) => m.subject)).toEqual(["Enki: database unreachable", "Enki: database unreachable"]);
  });

  it("retries an all clear that could not be sent", async () => {
    dbUp = false;
    await run();
    dbUp = true;
    mailWorks = false;
    await run();
    mailWorks = true;
    await run();
    expect(mails.map((m) => m.subject).slice(2)).toEqual(["Enki: database back", "Enki: database back"]);
  });

  it("refuses to run without recipients, a mail sender or a store for its state", async () => {
    for (const key of ["OPS_ALERT_EMAILS", "RESEND_API_KEY", "BLOB_READ_WRITE_TOKEN"]) {
      const kept = process.env[key];
      delete process.env[key];
      expect((await run()).status, key).toBe(503);
      process.env[key] = kept;
    }
  });

  it("refuses a caller that is not the scheduler", async () => {
    dbUp = false;
    const res = await GET(new NextRequest("http://enki.test/api/cron/db-health"));
    expect(res.status).toBe(401);
    expect(mails).toEqual([]);
  });
});
