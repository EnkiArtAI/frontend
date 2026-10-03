import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Every recorded free-form generation creates a private draft prompt row, and
 * its title was the first 60 characters of the prompt, in the clear, though
 * the body is encrypted. The public Hall of Fame then published a creator's
 * best prompt with its title whether or not that prompt was ever released.
 */

type Row = Record<string, unknown>;
let inserts: { table: string; row: Row }[];
let tables: Record<string, Row[]>;
let ranking: Row[];

function chain(table: string) {
  const rows = () => tables[table] ?? [];
  const q: Record<string, unknown> = {
    insert: (row: Row) => { inserts.push({ table, row }); return q; },
    single: async () => ({ data: { id: `${table}-1` }, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok),
  };
  for (const m of ["select", "eq", "in", "is", "gte", "order", "limit"]) q[m] = () => q;
  return q;
}
const fake = {
  from: chain,
  rpc: async (fn: string) => ({ data: fn.endsWith("_series") ? [] : ranking, error: null }),
};

vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => fake }));
vi.mock("@/lib/crypto", () => ({ encryptString: () => ({ encrypted: "ct", iv: "iv", authTag: "tag", kid: "k1" }) }));
vi.mock("@/lib/generation/derivative-store", () => ({ storeGeneratedImage: async () => null }));

import { recordGeneration } from "@/lib/generation/record";
import { GET as leaderboard } from "../../app/api/leaderboard/route";

const SECRET = "the artist's secret words, typed into the editor to test them";

beforeEach(() => {
  inserts = [];
  tables = {};
  ranking = [];
});

describe("a recorded generation's draft prompt", () => {
  it("never takes its title from the prompt", async () => {
    await recordGeneration(fake as never, {
      userId: "u1", promptId: null, finalPrompt: SECRET, effectivePrompt: SECRET, variableValues: {},
      model: { id: "m1", name: "Model" } as never, route: { provider: "p", providerModel: "pm" } as never,
      boost: false, aspectRatio: null, resolution: null, seed: null, output: null, generationMs: 1,
    } as never);
    const draft = inserts.find((i) => i.table === "prompts")?.row;
    expect(String(draft?.title)).not.toContain("secret");
  });
});

describe("the Hall of Fame", () => {
  async function rows() {
    const res = await leaderboard(new NextRequest("http://localhost/api/leaderboard?metric=generations&period=all"));
    return (await res.json()).rows as Row[];
  }

  beforeEach(() => {
    ranking = [
      { creator_id: "c1", handle: "a", total: 9, best_prompt_id: "draft", best_prompt_title: "the artist's secret words" },
      { creator_id: "c2", handle: "b", total: 5, best_prompt_id: "live", best_prompt_title: "Neon Koi" },
    ];
    tables.prompts = [
      { id: "draft", is_listed: false, listing_status: "draft", deleted_at: null },
      { id: "live", is_listed: true, listing_status: "active", deleted_at: null },
    ];
  });

  it("never publishes the title of a prompt that is not live", async () => {
    expect(JSON.stringify(await rows())).not.toContain("secret words");
  });

  it("still shows a live best prompt", async () => {
    expect((await rows())[1].bestPromptTitle).toBe("Neon Koi");
  });
});
