import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The 18+ confirmation (Kev, 2026-10-03): a user confirms in Settings that
 * they are 18 or older; only then does the feed offer its 18+ pill, off until
 * turned on. Withdrawing the confirmation hides 18+ again.
 */

let row: Record<string, unknown> | null;
const updates: Record<string, unknown>[] = [];

function chain() {
  const q: Record<string, unknown> = {
    maybeSingle: async () => ({ data: row, error: null }),
    update: (u: Record<string, unknown>) => { updates.push(u); return q; },
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null, count: 0 }).then(ok),
  };
  for (const m of ["select", "eq"]) q[m] = () => q;
  return q;
}

vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: chain }) }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async (_s: unknown, t: string | null) => (t === "tok" ? "user-1" : null) }));

import { GET, PATCH } from "../../app/api/users/handle/route";

const patch = (body: unknown) => PATCH(new NextRequest("http://enki.test/api/users/handle", {
  method: "PATCH", headers: { "X-Session-Token": "tok", "Content-Type": "application/json" }, body: JSON.stringify(body),
}));

beforeEach(() => {
  row = { handle: "kev", role: "user", adult_confirmed_at: null };
  updates.length = 0;
});

describe("the own account", () => {
  it("reads as confirmed once the user confirmed", async () => {
    row = { ...row, adult_confirmed_at: "2026-10-03T10:00:00Z" };
    const res = await GET(new NextRequest("http://enki.test/api/users/handle", { headers: { "X-Session-Token": "tok" } }));
    expect((await res.json()).adultConfirmed).toBe(true);
  });

  it("reads as unconfirmed before that", async () => {
    const res = await GET(new NextRequest("http://enki.test/api/users/handle", { headers: { "X-Session-Token": "tok" } }));
    expect((await res.json()).adultConfirmed).toBe(false);
  });
});

describe("confirming", () => {
  it("stores when the user confirmed", async () => {
    const res = await patch({ adultConfirmed: true });
    expect(await res.json()).toEqual({ adultConfirmed: true });
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0])).toEqual(["adult_confirmed_at"]);
    expect(Number.isNaN(Date.parse(String(updates[0].adult_confirmed_at)))).toBe(false);
  });

  it("can be withdrawn", async () => {
    const res = await patch({ adultConfirmed: false });
    expect(await res.json()).toEqual({ adultConfirmed: false });
    expect(updates).toEqual([{ adult_confirmed_at: null }]);
  });

  it("leaves the Hall of Fame setting alone, and that one still saves by itself", async () => {
    await patch({ hideFromLeaderboard: true });
    expect(updates).toEqual([{ hide_from_leaderboard: true }]);
  });

  it("refuses anything that is not a yes or no", async () => {
    expect((await patch({ adultConfirmed: "yes" })).status).toBe(400);
    expect(updates).toEqual([]);
  });

  it("needs a session", async () => {
    const res = await PATCH(new NextRequest("http://enki.test/api/users/handle", { method: "PATCH", body: JSON.stringify({ adultConfirmed: true }) }));
    expect(res.status).toBe(401);
    expect(updates).toEqual([]);
  });
});

describe("the screens", () => {
  const ROOT = join(__dirname, "..", "..");
  const src = (...p: string[]) => readSource(join(ROOT, ...p));

  it("the feed offers the pill only to a confirmed adult, and refetches when it flips", () => {
    const feed = src("components", "enki", "EnkiFeedPage.tsx");
    expect(feed).toMatch(/onShowAdult=\{adultConfirmed \? flipAdult : undefined\}/);
    expect(feed).toMatch(/const showAdult = adultConfirmed && adultPill;/);
    expect(feed).toMatch(/genFilter\.join\(","\), showAdult \? "18\+" : "safe"\]/);
    expect(feed).toMatch(/fetch\(`\/api\/marketplace\/prompts\?\$\{params\.toString\(\)\}`, \{ headers: viewerHeaders\(\)/);
  });

  it("the pill starts off", () => {
    expect(src("components", "enki", "EnkiFeedPage.tsx")).toMatch(/const \[adultPill, setAdultPill\] = useState\(false\);/);
  });

  it("the filter bar draws the pill only when given one", () => {
    expect(src("components", "enki", "EnkiFilters.tsx")).toMatch(/\{onShowAdult && \(\s*<span className="enki-fltr-group">/);
  });

  it("the sign-in check carries the confirmation app-wide", () => {
    expect(src("components", "BetaGate.tsx")).toMatch(/setAdultConfirmed\(data\.adultConfirmed === true\);/);
  });

  it("withdrawing in Settings turns the pill off too", () => {
    const settings = src("components", "settings", "SettingsView.tsx");
    expect(settings).toMatch(/body: JSON\.stringify\(\{ adultConfirmed: next \}\)/);
    expect(settings).toMatch(/setAdultConfirmed\(next\);/);
    expect(settings).toMatch(/if \(!next\) try \{ localStorage\.removeItem\(SHOW_ADULT_KEY\); \}/);
  });
});
