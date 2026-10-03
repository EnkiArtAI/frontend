import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Saving a prompt (Kev, 2026-10-03): judged whole — title, text, tags, every
 * variable's default and options — and only once the saver is known and owns
 * it. Suggestive text or an 18+ showcase render marks the prompt 18+ by itself.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

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
  then<A, B = never>(ok?: ((v: { data: unknown; error: null; count?: number }) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
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
vi.mock("@/lib/moderation", () => ({ moderate: async () => ({ allowed: true }), CLIENT_BLOCK_MESSAGE: "blocked" }));
vi.mock("@/lib/moderation-enforcement", () => ({ recordModerationEvent: async () => {} }));
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
      title: "Portrait", content: "Portrait of a woman, [outfit]", tags: "portrait", "variable outfit": "a red coat | Coat | a long coat",
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
