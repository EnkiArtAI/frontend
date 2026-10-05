import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A paid prompt's text is the artist's secret: buyers see its variables,
 * never the words around them. /api/prompt handed it out twice: GET decrypted
 * any prompt for anyone who knew its id, and every save wrote the first 220
 * characters in the clear to prompts.public_prompt_text, which the
 * marketplace then served.
 */

type Row = Record<string, unknown>;
type Result = { data: unknown; error: unknown; count?: number };

let db: Record<string, Row[]>;
let writes: { table: string; op: "insert" | "update"; row: Row }[];

class Query implements PromiseLike<Result> {
  private filters: ((r: Row) => boolean)[] = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private one = false;

  constructor(private table: string) {}

  select() { return this; }
  insert(row: Row | Row[]) { this.op = "insert"; this.payload = row; return this; }
  update(row: Row) { this.op = "update"; this.payload = row; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); return this; }
  in(col: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[col])); return this; }
  gt() { return this; }
  is() { return this; }
  order() { return this; }
  or() { return this; }
  limit() { return this; }
  maybeSingle() { this.one = true; return this; }
  single() { return this; }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, ko);
  }

  private run(): Result {
    const rows = db[this.table] ?? [];
    if (this.op === "insert") {
      for (const r of [this.payload].flat() as Row[]) {
        writes.push({ table: this.table, op: "insert", row: r });
        rows.push({ id: `new-${rows.length}`, ...r });
      }
      return { data: { id: rows[rows.length - 1].id }, error: null };
    }
    const hits = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      hits.forEach((r) => {
        writes.push({ table: this.table, op: "update", row: this.payload as Row });
        Object.assign(r, this.payload);
      });
      return { data: null, error: null, count: hits.length };
    }
    if (this.op === "delete") return { data: null, error: null };
    if (!this.one) return { data: hits, error: null };
    return { data: hits[0] ?? null, error: null };
  }
}

const fake = { from: (t: string) => new Query(t) };

const decrypt = vi.fn(() => "the artist's secret words around [subject]");

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => fake }));
vi.mock("@/lib/crypto", () => ({
  encryptString: () => ({ encrypted: "ct", iv: "iv", authTag: "tag", kid: "k1" }),
  decryptString: () => decrypt(),
}));
vi.mock("@/lib/moderation", () => ({ moderate: async () => ({ allowed: true }), CLIENT_BLOCK_MESSAGE: "blocked" }));
vi.mock("@/lib/moderation-enforcement", () => ({ recordModerationEvent: async () => {} }));
// The save's prompt check is a paid call; here it finds nothing.
vi.mock("@/lib/moderation/prompt-check", async (orig) => ({
  ...(await orig<typeof import("@/lib/moderation/prompt-check")>()),
  checkPrompt: async () => ({ verdict: "clear" }),
}));
vi.mock("@/lib/session-user", async (orig) => ({
  ...(await orig<typeof import("@/lib/session-user")>()),
  resolveSessionUserId: async (_s: unknown, token: string | null) =>
    ({ "artist-token": ARTIST, "buyer-token": BUYER, "email-token": EMAIL_USER } as Record<string, string>)[token ?? ""] ?? null,
}));

import { GET, POST } from "../../app/api/prompt/route";

const ARTIST = "aaaaaaaa-0000-4000-8000-000000000001";
const BUYER = "bbbbbbbb-0000-4000-8000-000000000002";
const PAID = "cccccccc-0000-4000-8000-000000000003";
const EMAIL_USER = "dddddddd-0000-4000-8000-000000000004";
const PHANTOM = "eeeeeeee-0000-4000-8000-000000000005";

beforeEach(() => {
  decrypt.mockClear();
  writes = [];
  db = {
    prompts: [{
      id: PAID, title: "Paid", creator_id: ARTIST, prompt_type: "paid", price_usd_cents: 150,
      encrypted_content: "ct", encrypted_content_iv: "iv", encrypted_content_tag: "tag", encrypted_content_kid: "k1",
    }],
    prompt_variables: [{ id: "v1", prompt_id: PAID, name: "subject", label: "subject", data_type: "text", position: 0 }],
    auth_sessions: [{ token: "artist-token", wallet_address: "ArtistWallet1111111111111111111111111111111", wallet_type: "solana" }],
    user_wallets: [{ user_id: ARTIST, address: "ArtistWallet1111111111111111111111111111111" }],
    users: [],
  };
});

const get = (token?: string) =>
  GET(new Request(`http://localhost/api/prompt?id=${PAID}`, { headers: token ? { "X-Session-Token": token } : {} }));

const save = (body: Row) =>
  POST(new Request("http://localhost/api/prompt", {
    method: "POST",
    headers: { "X-Session-Token": "artist-token", "Content-Type": "application/json" },
    body: JSON.stringify({ title: "T", content: "words around [subject]", aiModel: "nano-banana-pro", variables: [{ name: "subject", label: "subject", type: "text", position: 0, defaultValue: "fox" }], ...body }),
  }));

const promptWrite = () => writes.find((w) => w.table === "prompts")?.row;

describe("GET /api/prompt answers only the prompt's creator", () => {
  it("refuses a caller without a session", async () => {
    const res = await get();
    expect(res.status).toBe(401);
  });

  it("never decrypts for a caller without a session", async () => {
    await get();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("answers another user like a missing prompt", async () => {
    const res = await get("buyer-token");
    expect(res.status).toBe(404);
  });

  it("never decrypts for another user", async () => {
    await get("buyer-token");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("gives the full text to an email creator whose save made a phantom owner", async () => {
    // An email session holds users.id as its address; saving before the wallet
    // was attached mapped that address to a new user, who owns the prompt.
    db.prompts[0].creator_id = PHANTOM;
    db.auth_sessions.push({ token: "email-token", wallet_address: EMAIL_USER, wallet_type: "password" });
    db.user_wallets.push({ user_id: PHANTOM, address: EMAIL_USER });
    const res = await get("email-token");
    expect((await res.json()).content).toBe("the artist's secret words around [subject]");
  });

  it("gives the creator the full text", async () => {
    const res = await get("artist-token");
    expect((await res.json()).content).toBe("the artist's secret words around [subject]");
  });
});

describe("saving a prompt writes plaintext only for a free one", () => {
  it("writes no excerpt for a paid prompt", async () => {
    await save({ promptType: "paid-prompt", price: 1.5 });
    expect(promptWrite()?.public_prompt_text).toBeNull();
  });

  it("writes no excerpt for a create-now draft", async () => {
    await save({});
    expect(promptWrite()?.public_prompt_text).toBeNull();
  });

  it("writes the excerpt for a free prompt", async () => {
    await save({ promptType: "free-prompt", price: 0 });
    expect(promptWrite()?.public_prompt_text).toBe("words around [subject]");
  });

  it("writes the excerpt for a free showcase", async () => {
    await save({ isFreeShowcase: true, price: 0 });
    expect(promptWrite()?.public_prompt_text).toBe("words around [subject]");
  });

  it("clears the excerpt when a paid prompt is saved again", async () => {
    db.prompts[0].public_prompt_text = "the old excerpt";
    await save({ id: PAID, promptType: "paid-prompt", price: 1.5 });
    expect(db.prompts[0].public_prompt_text).toBeNull();
  });
});

describe("saving a prompt stores a price only for a paid one", () => {
  // The share card, the price filter and the card price read "free" from the cents alone,
  // and a save without a price used to store 100 cents whatever the type.
  it("stores 0 for a free prompt saved without a price", async () => {
    await save({ promptType: "free-prompt" });
    expect(promptWrite()?.price_usd_cents).toBe(0);
  });

  it("stores 0 for a free prompt even when a price was sent", async () => {
    const res = await save({ promptType: "free-prompt", price: 5 });
    expect(promptWrite()?.price_usd_cents).toBe(0);
    expect((await res.json()).price).toBe(0);
  });

  it("stores 0 for a free showcase", async () => {
    await save({ isFreeShowcase: true });
    expect(promptWrite()?.price_usd_cents).toBe(0);
  });

  it("stores a paid prompt's price in cents", async () => {
    const res = await save({ promptType: "paid-prompt", price: 1.5 });
    expect(promptWrite()?.price_usd_cents).toBe(150);
    expect((await res.json()).price).toBe(1.5);
  });

  it("drops the price when a paid prompt is saved again as free", async () => {
    db.prompts[0].price_usd_cents = 150;
    await save({ id: PAID, promptType: "free-prompt" });
    expect(db.prompts[0].price_usd_cents).toBe(0);
  });
});
