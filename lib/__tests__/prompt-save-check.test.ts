import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Saving a prompt (Kev, 2026-10-03): judged whole — title, text, tags, every
 * variable's default and options — and only once the saver is known and owns
 * it. Suggestive text or an 18+ showcase render marks the prompt 18+ by itself.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let failingTable: string | null = null;
let failingInsert: string | null = null;
let failingUpdate: string | null = null;

class Query implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private filters: ((r: Row) => boolean)[] = [];
  private op: "select" | "update" | "insert" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private one = false;
  constructor(private table: string) {}
  select() { return this; }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  insert(p: Row | Row[]) { this.op = "insert"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: null) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  gt(c: string, v: string) { this.filters.push((r) => String(r[c]) > v); return this; }
  limit() { return this; }
  order() { return this; }
  or(expr: string) {
    // Only the active-ban shape is used: "expires_at.is.null,expires_at.gt.<iso>".
    const iso = expr.split("expires_at.gt.")[1];
    this.filters.push((r) => r.expires_at == null || String(r.expires_at) > iso);
    return this;
  }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  // failingTable: reads of that table fail as an unreachable database's would.
  then<A, B = never>(ok?: ((v: { data: unknown; error: null; count?: number }) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    if (this.table === failingTable && this.op === "select") return Promise.resolve({ data: null, error: { message: "fetch failed" } as unknown as null }).then(ok, ko);
    // failingInsert: writes of new rows to that table are refused, as a broken constraint would.
    if (this.table === failingUpdate && this.op === "update") return Promise.resolve({ data: null, error: { message: "update refused" } as unknown as null }).then(ok, ko);
    if (this.table === failingInsert && this.op === "insert") return Promise.resolve({ data: null, error: { message: "insert refused" } as unknown as null }).then(ok, ko);
    const rows = (tables[this.table] ??= []);
    const hits = rows.filter((r) => this.filters.every((f) => f(r)));
    let res: { data: unknown; error: null; count?: number };
    if (this.op === "insert") {
      const added = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((p, i) => ({ id: `${this.table}-${rows.length + i + 1}`, ...p }));
      rows.push(...added);
      res = { data: this.one ? added[0] : added, error: null };
    } else if (this.op === "update") {
      hits.forEach((r) => Object.assign(r, this.payload));
      res = { data: null, error: null, count: hits.length };
    } else if (this.op === "delete") {
      tables[this.table] = rows.filter((r) => !hits.includes(r));
      res = { data: null, error: null };
    } else {
      res = { data: this.one ? hits[0] ?? null : hits, error: null };
    }
    return Promise.resolve(res).then(ok, ko);
  }
}
const fake = { from: (t: string) => new Query(t) };

const check = vi.fn();
const warn = vi.fn(async () => ({ total: 1, suspendedUntil: null, nextStepAt: 10 }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => fake }));
vi.mock("@/lib/crypto", () => ({ encryptString: () => ({ encrypted: "ct", iv: "iv", authTag: "tag", kid: "k1" }), decryptString: () => "" }));
const tier2 = vi.fn(async (_i: { prompt: string }) => ({ allowed: true }));
vi.mock("@/lib/moderation", () => ({ moderate: (i: { prompt: string }) => tier2(i), CLIENT_BLOCK_MESSAGE: "blocked" }));
const recorded = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/moderation-enforcement", () => ({ recordModerationEvent: (...a: unknown[]) => recorded(...a) }));
vi.mock("@/lib/moderation/warnings", () => ({ recordWarning: (...a: unknown[]) => warn(...(a as [])), warningMessage: () => "warned" }));
vi.mock("@/lib/moderation/prompt-check", async (original) => ({
  ...(await original<typeof import("@/lib/moderation/prompt-check")>()),
  checkPrompt: (inputs: Record<string, string>) => check(inputs),
}));

import { POST } from "../../app/api/prompt/route";

const save = (body: Row, token: string | null = "tok") => POST(new Request("http://enki.test/api/prompt", {
  method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Session-Token": token } : {}) }, body: JSON.stringify(body),
}));
const BASE = {
  title: "Portrait", content: "Portrait of a woman, [outfit]", aiModel: "nano-banana-pro", tags: ["portrait"],
  variables: [{ name: "outfit", label: "outfit", type: "text", defaultValue: "a red coat", position: 0 }],
};
const future = new Date(Date.now() + 86400_000).toISOString();
const EMAIL_USER = "3a3a3a3a-1111-4222-8333-444455556666";

beforeEach(() => {
  failingTable = null;
  failingInsert = null;
  failingUpdate = null;
  check.mockReset();
  check.mockResolvedValue({ verdict: "clear" });
  warn.mockClear();
  tables = {
    auth_sessions: [
      { token: "tok", wallet_address: "w1", expires_at: future },
      { token: "other", wallet_address: "w2", expires_at: future },
      // An email login carries the users.id until a wallet is attached.
      { token: "email", wallet_address: EMAIL_USER, wallet_type: "password", expires_at: future },
    ],
    users: [], bans: [],
    user_wallets: [{ address: "w1", user_id: "u1", removed_at: null }, { address: "w2", user_id: "u2", removed_at: null }],
    prompts: [], prompt_variables: [], generated_images: [],
  };
});

describe("saving a prompt", () => {
  it("judges title, text, tags and every variable's values", async () => {
    await save({ ...BASE, variables: [{ ...BASE.variables[0], options: [{ visibleName: "Coat", promptValue: "a long coat" }] }] });
    expect(check).toHaveBeenCalledOnce();
    expect(check.mock.calls[0][0]).toEqual({
      title: "Portrait", content: "Portrait of a woman, [outfit]", tags: "portrait", "variable 1": "outfit | a red coat | Coat | a long coat",
    });
  });

  it("marks a prompt 18+ when the check finds it suggestive", async () => {
    check.mockResolvedValue({ verdict: "clear", adult: true });
    expect((await save(BASE)).status).toBe(200);
    expect(tables.prompts[0].is_adult).toBe(true);
  });

  it("marks a prompt 18+ when a showcase image is an 18+ render", async () => {
    tables.generated_images.push({ id: "g1", storage_url: "https://blob/x.png", is_adult: true });
    await save({ ...BASE, uploadedPhotos: ["https://blob/x.png"] });
    expect(tables.prompts[0].is_adult).toBe(true);
  });

  it("leaves an ordinary prompt below 18", async () => {
    tables.generated_images.push({ id: "g1", storage_url: "https://blob/y.png", is_adult: false });
    await save({ ...BASE, uploadedPhotos: ["https://blob/y.png"] });
    expect(tables.prompts[0].is_adult).toBe(false);
  });

  it("refuses explicit content with a warning and saves nothing", async () => {
    check.mockResolvedValue({ verdict: "explicit_sexual", confidence: 0.9 });
    expect((await save(BASE)).status).toBe(422);
    expect(warn).toHaveBeenCalledOnce();
    expect(tables.prompts).toEqual([]);
  });

  it("keeps the body of a refused save from every moderator", async () => {
    check.mockResolvedValue({ verdict: "explicit_sexual", confidence: 0.9 });
    await save(BASE);
    const ctx = (warn.mock.calls[0] as unknown[])[1] as { text: string; withheld?: string };
    expect(ctx.text).not.toContain("Portrait of a woman");
    expect(ctx.text).toContain("Portrait");
    expect(ctx.withheld).toBe("Portrait of a woman, [outfit]");
  });

  it("keeps the body of a save tier 2 blocks from every moderator", async () => {
    tier2.mockResolvedValueOnce({ allowed: false });
    recorded.mockClear();
    expect((await save(BASE)).status).toBe(422);
    const ctx = recorded.mock.calls[0][1] as { prompt: string; withheld?: string };
    expect(ctx.prompt).not.toContain("Portrait of a woman");
    expect(ctx.withheld).toBe("Portrait of a woman, [outfit]");
    // Tier 2 itself still judged the whole prompt.
    expect(tier2.mock.calls.at(-1)![0].prompt).toContain("Portrait of a woman");
  });

  it("saves nothing while the check is unavailable", async () => {
    check.mockResolvedValue({ verdict: "unavailable", reason: "api 500" });
    expect((await save(BASE)).status).toBe(503);
    expect(tables.prompts).toEqual([]);
  });

  it("costs no check and earns no warning without a session", async () => {
    expect((await save(BASE, null)).status).toBe(401);
    expect(check).not.toHaveBeenCalled();
  });

  it("costs no check on someone else's prompt", async () => {
    tables.prompts.push({ id: "11111111-1111-4111-8111-111111111111", creator_id: "u1" });
    expect((await save({ ...BASE, id: "11111111-1111-4111-8111-111111111111" }, "other")).status).toBe(404);
    expect(check).not.toHaveBeenCalled();
  });

  it("re-judges an owner's edit", async () => {
    tables.prompts.push({ id: "11111111-1111-4111-8111-111111111111", creator_id: "u1", is_adult: false });
    check.mockResolvedValue({ verdict: "clear", adult: true });
    expect((await save({ ...BASE, id: "11111111-1111-4111-8111-111111111111" })).status).toBe(200);
    expect(tables.prompts[0].is_adult).toBe(true);
  });
});

describe("who saves", () => {
  it("an email login saves under its own account, minting no second user", async () => {
    expect((await save(BASE, "email")).status).toBe(200);
    expect(tables.prompts[0].creator_id).toBe(EMAIL_USER);
    expect(tables.users).toEqual([]);
    expect(tables.user_wallets).toHaveLength(2);
  });

  it("an email login updates the prompts it owns", async () => {
    tables.prompts.push({ id: "11111111-1111-4111-8111-111111111111", creator_id: EMAIL_USER, is_adult: false });
    expect((await save({ ...BASE, id: "11111111-1111-4111-8111-111111111111" }, "email")).status).toBe(200);
  });

  it("a suspended account saves nothing and costs no check", async () => {
    tables.bans.push({ user_id: "u1", lifted_at: null, expires_at: null });
    expect((await save(BASE)).status).toBe(401);
    expect(check).not.toHaveBeenCalled();
  });
});

describe("judged whole", () => {
  it("includes a variable's label and description, which buyers see", async () => {
    await save({ ...BASE, variables: [{ ...BASE.variables[0], label: "Lingerie style", description: "how revealing" }] });
    expect(check.mock.calls[0][0]["variable 1"]).toBe("outfit | Lingerie style | how revealing | a red coat");
  });

  it("includes the stored description on an update, so a re-save cannot lower its 18+ mark", async () => {
    tables.prompts.push({ id: "11111111-1111-4111-8111-111111111111", creator_id: "u1", description: "a sultry boudoir scene", is_adult: true });
    check.mockImplementation(async (inputs: Record<string, string>) => (inputs.description ? { verdict: "clear", adult: true } : { verdict: "clear" }));
    await save({ ...BASE, id: "11111111-1111-4111-8111-111111111111" });
    expect(check.mock.calls[0][0].description).toBe("a sultry boudoir scene");
    expect(tables.prompts[0].is_adult).toBe(true);
  });

  it("hands tier 2 the same whole", async () => {
    tier2.mockClear();
    await save({ ...BASE, variables: [{ ...BASE.variables[0], defaultValue: "sheer lingerie" }] });
    expect(tier2.mock.calls[0][0].prompt).toContain("sheer lingerie");
  });
});

describe("variables sharing a name", () => {
  it("are each judged, none hiding another", async () => {
    await save({ ...BASE, variables: [
      { name: "outfit", label: "outfit", type: "text", defaultValue: "sheer lingerie", position: 0 },
      { name: "outfit", label: "outfit", type: "text", defaultValue: "a red coat", position: 1 },
    ] });
    const judged = check.mock.calls[0][0] as Record<string, string>;
    expect(judged["variable 1"]).toContain("sheer lingerie");
    expect(judged["variable 2"]).toContain("a red coat");
  });
});

describe("a showcase lookup that fails", () => {
  it("saves nothing rather than a guessed 18+ mark", async () => {
    failingTable = "generated_images";
    expect((await save({ ...BASE, uploadedPhotos: ["https://blob/x.png"] })).status).toBe(503);
    expect(tables.prompts).toEqual([]);
  });
});

describe("releasing a prompt", () => {
  // Kev, 2026-10-05: the artist lists a prompt when they want, once the checks have passed.
  // Nothing set is_listed before, so a released prompt was for sale to nobody.
  const owned = (extra: Row = {}) => {
    tables.prompts.push({ id: "11111111-1111-4111-8111-111111111111", creator_id: "u1", title: "Portrait", description: null, ...extra });
    return tables.prompts[0];
  };
  const ID = "11111111-1111-4111-8111-111111111111";

  it("lists it for sale once the checks have passed", async () => {
    expect((await save({ ...BASE, release: true })).status).toBe(200);
    expect(tables.prompts[0]).toMatchObject({ is_listed: true, listing_status: "active" });
    expect(tables.prompts[0].listed_at).toBeTruthy();
    expect(tables.prompts[0].published_at).toBeTruthy();
  });

  it("leaves a prompt saved without a release unlisted", async () => {
    await save(BASE);
    expect(tables.prompts[0]).not.toHaveProperty("is_listed");
    expect(tables.prompts[0]).not.toHaveProperty("listing_status");
  });

  it("lists nothing the prompt check refuses", async () => {
    check.mockResolvedValue({ verdict: "explicit_sexual", confidence: 0.9 });
    expect((await save({ ...BASE, release: true })).status).toBe(422);
    expect(tables.prompts).toEqual([]);
  });

  it("lists nothing that moderation blocks, and nothing while the check is unavailable", async () => {
    const row = owned({ is_listed: false, listing_status: "draft" });
    tier2.mockResolvedValueOnce({ allowed: false });
    expect((await save({ ...BASE, id: ID, release: true })).status).toBe(422);
    check.mockResolvedValue({ verdict: "unavailable", reason: "api 500" });
    expect((await save({ ...BASE, id: ID, release: true })).status).toBe(503);
    expect(row).toMatchObject({ is_listed: false, listing_status: "draft" });
  });

  it("lists a suggestive prompt, marked 18+", async () => {
    check.mockResolvedValue({ verdict: "clear", adult: true });
    await save({ ...BASE, release: true });
    expect(tables.prompts[0]).toMatchObject({ is_listed: true, is_adult: true });
  });

  it("lists an existing draft and keeps a listed prompt's first dates", async () => {
    const row = owned({ is_listed: false, listing_status: "draft", listed_at: null, published_at: null });
    await save({ ...BASE, id: ID, release: true });
    expect(row).toMatchObject({ is_listed: true, listing_status: "active" });
    const first = { listed_at: "2026-09-01T00:00:00.000Z", published_at: "2026-08-30T00:00:00.000Z" };
    Object.assign(row, first);
    await save({ ...BASE, id: ID, release: true });
    expect(row).toMatchObject(first);
  });

  it("leaves a listed prompt listed when it is saved again without a release", async () => {
    const row = owned({ is_listed: true, listing_status: "active", listed_at: "2026-09-01T00:00:00.000Z" });
    await save({ ...BASE, id: ID });
    expect(row).toMatchObject({ is_listed: true, listing_status: "active", listed_at: "2026-09-01T00:00:00.000Z" });
  });

  it("never lists again what a moderator took down, and costs no check", async () => {
    const row = owned({ is_listed: false, listing_status: "active", delisted_at: "2026-10-01T00:00:00.000Z", title: "Taken down" });
    const res = await save({ ...BASE, id: ID, release: true });
    expect(res.status).toBe(403);
    expect(row).toMatchObject({ is_listed: false, title: "Taken down" });
    expect(check).not.toHaveBeenCalled();
    // Its artist may still edit it, unlisted.
    expect((await save({ ...BASE, id: ID })).status).toBe(200);
    expect(row).toMatchObject({ is_listed: false, title: "Portrait" });
  });

  it("lists nothing whose variables could not be written", async () => {
    failingInsert = "prompt_variables";
    expect((await save({ ...BASE, release: true })).status).toBe(500);
    expect(tables.prompts[0].is_listed).not.toBe(true);
  });

  it("answers an error, not a release, when the listing itself could not be written", async () => {
    failingUpdate = "prompts";
    expect((await save({ ...BASE, release: true })).status).toBe(500);
    expect(tables.prompts[0].is_listed).not.toBe(true);
  });

  it("leaves a draft a draft when its variables could not be written", async () => {
    failingInsert = "prompt_variables";
    const row = owned({ is_listed: false, listing_status: "draft" });
    expect((await save({ ...BASE, id: ID, release: true })).status).toBe(500);
    expect(row).toMatchObject({ is_listed: false, listing_status: "draft" });
  });

  it("stays down when a moderator takes it down while the release is being checked", async () => {
    const row = owned({ is_listed: false, listing_status: "draft", delisted_at: null });
    // The takedown lands after the ownership read, before anything is written.
    check.mockImplementation(async () => {
      Object.assign(row, { is_listed: false, delisted_at: "2026-10-05T12:00:00.000Z" });
      return { verdict: "clear" };
    });
    const res = await save({ ...BASE, id: ID, release: true });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("stays unlisted");
    expect(row).toMatchObject({ is_listed: false, listing_status: "draft", delisted_at: "2026-10-05T12:00:00.000Z" });
  });

  it("releases nobody else's prompt", async () => {
    const row = owned({ creator_id: "u2", is_listed: false });
    expect((await save({ ...BASE, id: ID, release: true })).status).toBe(404);
    expect(row.is_listed).toBe(false);
  });
});

describe("the save route's ownership read", () => {
  it("asks for the takedown mark and the first listing dates, which this file's fake would hand over unasked", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "..", "app", "api", "prompt", "route.ts"), "utf8");
    expect(src).toContain('.select("id, description, delisted_at, listed_at, published_at").eq("id", body.id).in("creator_id", owners)');
  });
});

describe("a variable that hides text from the check", () => {
  // The check reads a variable's fields one level deep; anything nested would be stored unjudged.
  const withVariable = (extra: Row) => save({ ...BASE, variables: [{ ...BASE.variables[0], ...extra }] });
  const refused = async (extra: Row) => {
    const res = await withVariable(extra);
    expect(res.status).toBe(400);
    expect(check).not.toHaveBeenCalled();
    expect(tables.prompts).toEqual([]);
    expect(tables.prompt_variables).toEqual([]);
  };

  it("is refused when its default is an object", () => refused({ defaultValue: { text: "explicit" } }));
  it("is refused when its default nests a list in a list", () => refused({ defaultValue: [["explicit"]] }));
  it("is refused when its default lists an object", () => refused({ defaultValue: [{ text: "explicit" }] }));
  it("is refused when an option's value is not text", () => refused({ options: [{ visibleName: "A", promptValue: ["explicit"] }] }));
  it("is refused when an option's shown name is not text", () => refused({ options: [{ visibleName: { a: "explicit" }, promptValue: "a" }] }));
  it("is refused when an option's label is not text", () => refused({ options: [{ label: ["explicit"], promptValue: "a" }] }));
  it("is refused when an option is no object", () => refused({ options: [null] }));
  it("is refused when its options are no list", () => refused({ options: { 0: { promptValue: "explicit" } } }));
  it("is refused when its label is not text", () => refused({ label: ["explicit"] }));
  it("is refused when its description is not text", () => refused({ description: { a: "explicit" } }));
  it("is refused when its name is not text", () => refused({ name: ["outfit"] }));
  it("is refused when it is no object", async () => {
    expect((await save({ ...BASE, content: "Portrait", variables: ["explicit"] })).status).toBe(400);
    expect(tables.prompts).toEqual([]);
  });

  it("is saved with a text, a number, a yes/no or a flat list as its default, each text judged", async () => {
    for (const defaultValue of ["a red coat", 3, true, ["a red coat", "a blue coat", 2]]) {
      expect((await withVariable({ defaultValue })).status).toBe(200);
    }
    expect(check.mock.calls.at(-1)![0]["variable 1"]).toBe("outfit | a red coat | a blue coat");
  });
});
