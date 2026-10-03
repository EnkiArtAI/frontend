import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The Hall of Fame is public (Kev, 2026-10-03): a creator whose best prompt
 * is 18+ keeps the rank, but that prompt shows no title, link or image on
 * any row, not even one of its renders.
 */

type Row = Record<string, unknown>;
let ranking: Row[];
let prompts: Row[];
let renders: Row[];
let promptsFail = false;

const chain = (rows: () => Row[]) => {
  const filters: ((r: Row) => boolean)[] = [];
  let cols: string[] | null = null;
  const q = {
    // Only the selected columns come back, as from PostgREST.
    select: (c: string) => { cols = c.split(",").map((x) => x.trim()); return q; },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
    is: (c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return q; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    gte: () => q,
    order: () => q,
    limit: () => q,
    then: (ok: (v: unknown) => unknown) => Promise.resolve({
      data: rows().filter((r) => filters.every((f) => f(r))).map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r)),
      error: null,
    }).then(ok),
  };
  return q;
};
/** A read that fails, as an unreachable database answers. */
const failing = () => {
  const q = { select: () => q, in: () => q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "fetch failed" } }).then(ok) };
  return q;
};
const fake = {
  rpc: async (name: string) => ({ data: name.startsWith("leaderboard_gen") && !name.includes("series") ? ranking : [], error: null }),
  from: (t: string) => (t === "prompts" && promptsFail ? failing() : chain(() => (t === "prompts" ? prompts : t === "generated_images" ? renders : []))),
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => fake }));

import { GET } from "../../app/api/leaderboard/route";

const rows = async () => (await (await GET(new NextRequest("http://enki.test/api/leaderboard?metric=generations&period=week"))).json()).rows as Row[];
const rank = (n: number, prompt: string) => ({ creator_id: `c${n}`, handle: `h${n}`, total: 100 - n, best_prompt_id: prompt, best_prompt_title: `Title ${prompt}` });

beforeEach(() => {
  ranking = [rank(1, "p1"), rank(2, "p2"), rank(3, "p3"), rank(4, "p4"), rank(5, "p5")];
  prompts = ["p1", "p2", "p3", "p4", "p5"].map((id) => ({ id, is_adult: false, is_listed: true, listing_status: "active", deleted_at: null, showcase_images: [`https://img/${id}.png`] }));
  renders = [];
  promptsFail = false;
});

describe("the Hall of Fame", () => {
  it("shows an ordinary podium prompt with its title and image", async () => {
    expect((await rows())[0]).toMatchObject({ rank: 1, bestPromptId: "p1", bestPromptTitle: "Title p1", image: "https://img/p1.png" });
  });

  it("keeps an 18+ creator's rank but shows no title, link or image", async () => {
    prompts[0].is_adult = true;
    expect((await rows())[0]).toMatchObject({ rank: 1, handle: "h1", bestPromptId: null, bestPromptTitle: null, image: null });
  });

  it("does so on every row, not only the podium", async () => {
    prompts[4].is_adult = true;
    expect((await rows())[4]).toMatchObject({ rank: 5, bestPromptTitle: null, bestPromptId: null });
  });

  it("does not fall back to one of the 18+ prompt's renders", async () => {
    prompts[0] = { id: "p1", is_adult: true, is_listed: true, listing_status: "active", deleted_at: null, showcase_images: [] };
    renders.push({ prompt_id: "p1", storage_url: "https://img/render.png", deleted_at: null, is_adult: false });
    expect((await rows())[0].image).toBeNull();
  });

  it("shows no 18+ render even for an ordinary prompt", async () => {
    prompts[0] = { id: "p1", is_adult: false, is_listed: true, listing_status: "active", deleted_at: null, showcase_images: [] };
    renders.push({ prompt_id: "p1", storage_url: "https://img/adult-render.png", deleted_at: null, is_adult: true });
    expect((await rows())[0].image).toBeNull();
  });

  it("shows no title of a prompt that was never released", async () => {
    prompts[1].is_listed = false;
    expect((await rows())[1]).toMatchObject({ rank: 2, bestPromptId: null, bestPromptTitle: null, image: null });
  });

  it("shows images on the podium only", async () => {
    expect((await rows())[3].image).toBeNull();
  });
});

describe("when the prompts cannot be read", () => {
  it("shows no title, link or image at all", async () => {
    promptsFail = true;
    for (const r of await rows()) expect(r).toMatchObject({ bestPromptId: null, bestPromptTitle: null, image: null });
  });
});
