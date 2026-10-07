import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The search routes ask the database for 18+ exactly when the feed would
 * show it: the server's own verdict on the viewer (a confirmed adult with the
 * pill on), never a request parameter.
 */

const view = vi.hoisted(() => ({ showAdult: true }));
vi.mock("@/lib/adult-content", () => ({ viewer: async () => ({ userId: "u1", showAdult: view.showAdult }) }));
const calls: { fn: string; args: Record<string, unknown> }[] = [];
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: [], error: null }; },
  }),
}));

import { GET as search } from "../../app/api/search/route";
import { GET as suggest } from "../../app/api/search/suggest/route";

let ip = 0;
const get = (path: string) => new NextRequest(`http://enki.test${path}`, { headers: { "x-real-ip": `10.9.0.${++ip}` } });

describe("search and suggestions", () => {
  it.each([true, false])("pass the viewer's 18+ verdict (%s) to every query, whatever the URL says", async (adult) => {
    view.showAdult = adult;
    calls.length = 0;
    await search(get("/api/search?q=dragon&type=all&show_adult=true"));
    await suggest(get("/api/search/suggest?q=dra&show_adult=true"));
    expect(calls.map((c) => c.fn)).toEqual(["search_prompts", "search_creators", "suggest_titles", "search_creators"]);
    for (const c of calls) expect(c.args.show_adult, c.fn).toBe(adult);
  });
});
