import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Editing a prompt's title, description or tags (PATCH /api/prompts/[id]) is
 * judged like a save: a prompt saved clean must not turn explicit or 18+
 * afterwards (found by review, 2026-10-03).
 */

type Row = Record<string, unknown>;
let prompts: Row[];

const query = (table: string) => {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  const q = {
    select: () => q,
    update: (p: Row) => { patch = p; return q; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
    is: () => q,
    maybeSingle: async () => ({ data: prompts.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
    then: (ok: (v: unknown) => unknown) => {
      const hits = prompts.filter((r) => filters.every((f) => f(r)));
      hits.forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ data: null, error: null, count: hits.length }).then(ok);
    },
  };
  return q;
};

const check = vi.fn();
const warn = vi.fn(async () => ({ total: 1, suspendedUntil: null, nextStepAt: 10 }));
const tier2 = vi.fn(async (): Promise<{ allowed: boolean; tier2Degraded?: boolean }> => ({ allowed: true }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: query }) }));
// "tok" owns as u1; "email" is an email login (users.id u3 in the session)
// whose address was first mapped to ph3; "banned" is suspended and owns nothing.
const OWNERS: Record<string, string[] | null> = { tok: ["u1"], email: ["u3", "ph3"], banned: null };
vi.mock("@/lib/session-user", () => ({
  resolveOwnerIds: async (_s: unknown, t: string | null) => OWNERS[t ?? ""] ?? null,
}));
vi.mock("@/lib/moderation", () => ({ moderate: (...a: unknown[]) => tier2(...(a as [])), CLIENT_BLOCK_MESSAGE: "blocked" }));
vi.mock("@/lib/moderation-enforcement", () => ({ recordModerationEvent: async () => {} }));
vi.mock("@/lib/moderation/warnings", () => ({ recordWarning: (...a: unknown[]) => warn(...(a as [])), warningMessage: () => "warned" }));
vi.mock("@/lib/moderation/prompt-check", () => ({ checkPrompt: (inputs: Record<string, string>) => check(inputs) }));

import { PATCH } from "../../app/api/prompts/[id]/route";

const edit = (id: string, body: Row, token = "tok") => PATCH(new NextRequest(`http://enki.test/api/prompts/${id}`, {
  method: "PATCH", headers: { "Content-Type": "application/json", "X-Session-Token": token }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) });

beforeEach(() => {
  check.mockReset();
  check.mockResolvedValue({ verdict: "clear" });
  warn.mockClear();
  tier2.mockReset();
  tier2.mockResolvedValue({ allowed: true });
  prompts = [{ id: "p1", creator_id: "u1", title: "Portrait", is_adult: false }, { id: "p2", creator_id: "u2", title: "Theirs" }];
});

describe("editing a prompt", () => {
  it("judges the edited title, description and tags", async () => {
    await edit("p1", { title: "New", description: "A scene", tags: ["a", "b"], category: "Poster" });
    expect(check).toHaveBeenCalledWith({ title: "New", description: "A scene", tags: "a, b" });
  });

  it("refuses an explicit edit with a warning and changes nothing", async () => {
    check.mockResolvedValue({ verdict: "explicit_sexual", confidence: 0.9 });
    expect((await edit("p1", { title: "explicit" })).status).toBe(422);
    expect(warn).toHaveBeenCalledOnce();
    expect(prompts[0].title).toBe("Portrait");
  });

  it("marks the prompt 18+ when the edit is suggestive", async () => {
    check.mockResolvedValue({ verdict: "clear", adult: true });
    expect((await edit("p1", { title: "Boudoir" })).status).toBe(200);
    expect(prompts[0]).toMatchObject({ title: "Boudoir", is_adult: true });
  });

  it("never lowers an 18+ mark", async () => {
    prompts[0].is_adult = true;
    await edit("p1", { title: "Quiet title" });
    expect(prompts[0].is_adult).toBe(true);
  });

  it("changes nothing while the check is unavailable", async () => {
    check.mockResolvedValue({ verdict: "unavailable", reason: "api 500" });
    expect((await edit("p1", { title: "New" })).status).toBe(503);
    expect(prompts[0].title).toBe("Portrait");
  });

  it("refuses what tier 2 blocks", async () => {
    tier2.mockResolvedValue({ allowed: false });
    expect((await edit("p1", { title: "New" })).status).toBe(422);
    expect(prompts[0].title).toBe("Portrait");
  });

  it("costs no check on someone else's prompt", async () => {
    expect((await edit("p2", { title: "Mine now" })).status).toBe(404);
    expect(check).not.toHaveBeenCalled();
  });

  it("leaves someone else's prompt alone when no text changes either", async () => {
    expect((await edit("p2", { category: "Poster" })).status).toBe(404);
    expect(prompts[1].category).toBeUndefined();
  });

  it("costs no check when no text changes", async () => {
    expect((await edit("p1", { category: "Poster" })).status).toBe(200);
    expect(check).not.toHaveBeenCalled();
  });
});

describe("who edits", () => {
  it("an email login edits the prompts it owns", async () => {
    prompts.push({ id: "p3", creator_id: "u3", title: "Mine" });
    expect((await edit("p3", { category: "Poster" }, "email")).status).toBe(200);
    expect(prompts.find((p) => p.id === "p3")?.category).toBe("Poster");
  });

  it("publishes nothing: a prompt is published by its release", async () => {
    prompts.push({ id: "p3", creator_id: "u3", title: "Mine" }, { id: "p5", creator_id: "u3", title: "Live", published_at: "2026-09-01T00:00:00.000Z" });
    expect((await edit("p3", { published: true }, "email")).status).toBe(200);
    expect(prompts.find((p) => p.id === "p3")).not.toHaveProperty("published_at");
    await edit("p5", { published: true, category: "Poster" }, "email");
    expect(prompts.find((p) => p.id === "p5")?.published_at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("an email login edits a prompt owned through its first address mapping", async () => {
    prompts.push({ id: "p4", creator_id: "ph3", title: "Old save" });
    expect((await edit("p4", { title: "Renamed" }, "email")).status).toBe(200);
    expect(prompts.find((p) => p.id === "p4")?.title).toBe("Renamed");
  });

  it("a suspended account edits nothing", async () => {
    expect((await edit("p1", { title: "New" }, "banned")).status).toBe(401);
    expect(prompts[0].title).toBe("Portrait");
    expect(check).not.toHaveBeenCalled();
  });
});

describe("editing while tier 2 is down", () => {
  // It answers "allowed" then; a listed prompt's public text must not change on a check that never ran.
  it("changes nothing on a listed prompt", async () => {
    prompts[0].is_listed = true;
    tier2.mockResolvedValue({ allowed: true, tier2Degraded: true });
    expect((await edit("p1", { title: "New" })).status).toBe(503);
    expect(prompts[0].title).toBe("Portrait");
  });

  it("still edits a draft, which is judged again at its release", async () => {
    tier2.mockResolvedValue({ allowed: true, tier2Degraded: true });
    expect((await edit("p1", { title: "New" })).status).toBe(200);
    expect(prompts[0].title).toBe("New");
  });

  it("reads the listing with the ownership, which this file's fake would hand over unasked", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "..", "app", "api", "prompts", "[id]", "route.ts"), "utf8");
    expect(src).toContain('.select("id, is_listed")');
  });
});
