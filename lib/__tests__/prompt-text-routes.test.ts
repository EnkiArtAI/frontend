import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The marketplace feed and the prompt detail route are what every visitor
 * past the beta gate reads, with no session. Both handed out a paid prompt's
 * text: the feed as description and promptTemplate (the stored first 220
 * characters), the detail route as publicPromptText. A paid prompt's buyers
 * see its variables, never its words.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

/** Every filter is a no-op: each test seeds exactly the rows the route should see. */
function chain(table: string) {
  const rows = () => tables[table] ?? [];
  const q: Record<string, unknown> = {
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null, count: rows().length }).then(ok),
  };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "ilike", "gte", "lte", "gt", "lt", "order", "range", "limit", "contains", "overlaps"]) q[m] = () => q;
  return q;
}

vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: chain }) }));
vi.mock("@/lib/crypto", () => ({ decryptString: () => "the full free text" }));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async (_s: unknown, token: string | null) => (token === "owner-token" ? "owner-1" : null),
}));

import { GET as feed } from "../../app/api/marketplace/prompts/route";
import { GET as detail } from "../../app/api/prompts/[id]/route";

const SECRET = "the artist's secret words around [subject]";
const LIVE = { is_listed: true, listing_status: "active", deleted_at: null };
const paid: Row = { id: "p1", title: "Paid", prompt_type: "paid", price_usd_cents: 150, public_prompt_text: SECRET, description: "A moody portrait", encrypted_content: "ct", ...LIVE };
const showcase: Row = { id: "s1", title: "Free", creator_id: "owner-1", prompt_type: "create-now", is_free_showcase: true, price_usd_cents: 0, public_prompt_text: "a free [subject]", description: null, encrypted_content: "ct", ...LIVE };

beforeEach(() => {
  tables = { prompts: [], prompt_variables: [], users: [], user_wallets: [] };
});

async function card(row: Row) {
  tables.prompts = [row];
  const res = await feed(new NextRequest("http://localhost/api/marketplace/prompts"));
  return (await res.json()).prompts[0];
}

async function detailOf(row: Row, token?: string) {
  tables.prompts = [row];
  const req = new Request(`http://localhost/api/prompts/${row.id}`, { headers: token ? { "X-Session-Token": token } : {} });
  const res = await detail(req, { params: Promise.resolve({ id: String(row.id) }) });
  return (await res.json()).prompt;
}

describe("the marketplace feed", () => {
  it("never puts a paid prompt's text in its card", async () => {
    expect(JSON.stringify(await card(paid))).not.toContain("secret words");
  });

  it("describes a paid prompt with its creator's description", async () => {
    expect((await card(paid)).description).toBe("A moody portrait");
  });

  it("keeps a free showcase's text", async () => {
    expect((await card(showcase)).promptTemplate).toBe("a free [subject]");
  });
});

describe("the prompt detail route", () => {
  it("never sends a paid prompt's text", async () => {
    expect(await detailOf(paid)).not.toHaveProperty("publicPromptText", expect.anything());
  });

  it("sends a listed free showcase's full text", async () => {
    expect((await detailOf(showcase)).publicPromptText).toBe("the full free text");
  });

  it("lets the creator preview their own unlisted free prompt", async () => {
    const draft = { ...showcase, is_listed: false, listing_status: "draft" };
    expect((await detailOf(draft, "owner-token")).publicPromptText).toBe("the full free text");
  });

  it("never sends the text of an unlisted free prompt", async () => {
    const draft = { ...showcase, is_listed: false, listing_status: "draft" };
    expect((await detailOf(draft)).publicPromptText).toBeUndefined();
  });
});
