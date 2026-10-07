import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * REC-7. Abandoned payment authorisations are swept on a schedule, not only
 * when someone happens to generate. The cron route is public in the proxy,
 * so CRON_SECRET is its only door.
 */

const sweep = vi.fn(async () => 0);
vi.mock("@/lib/payments/settle", () => ({ sweepAndFlush: (...a: unknown[]) => sweep(...(a as [])) }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({}) }));

import { GET } from "../../app/api/cron/sweep-payments/route";
import { proxy } from "../../proxy";

const ROOT = join(__dirname, "..", "..");
const call = (auth?: string) =>
  GET(new NextRequest("http://enki.test/api/cron/sweep-payments", { headers: auth ? { authorization: auth } : {} }));

beforeEach(() => {
  sweep.mockClear();
  process.env.CRON_SECRET = "cron-secret";
});

describe("the payment sweep cron", () => {
  it("sweeps when Vercel's scheduler calls", async () => {
    const res = await call("Bearer cron-secret");
    expect(res.status).toBe(200);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("voids and closes one row of each kind per round until nothing is left", async () => {
    sweep.mockResolvedValueOnce(2).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const res = await call("Bearer cron-secret");
    expect(await res.json()).toEqual({ swept: 3 });
    expect(sweep).toHaveBeenCalledTimes(3);
    for (const args of sweep.mock.calls) expect((args as unknown[])[1]).toBe(1);
  });

  it("starts no new round after two minutes, so the last one ends inside the function's limit", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    sweep.mockImplementation(async () => { now += 50_000; return 2; });
    const res = await call("Bearer cron-secret");
    clock.mockRestore();
    sweep.mockImplementation(async () => 0);
    expect(sweep).toHaveBeenCalledTimes(3); // started at 0, 50 and 100 s; none at 150 s
    expect(await res.json()).toEqual({ swept: 6 });
  });

  it("refuses anyone else", async () => {
    for (const auth of [undefined, "Bearer wrong", "cron-secret", "Bearer cron-secretX"]) {
      expect((await call(auth)).status, String(auth)).toBe(401);
    }
    expect(sweep).not.toHaveBeenCalled();
  });

  it("stays shut when no secret is configured", async () => {
    delete process.env.CRON_SECRET;
    expect((await call("Bearer ")).status).toBe(503);
    expect((await call("Bearer undefined")).status).toBe(503);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("is reachable without the team cookie", () => {
    process.env.TEAM_ACCESS_CODE = "team-code";
    const res = proxy(new NextRequest("http://enki.test/api/cron/sweep-payments"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("is scheduled, and every scheduled path has a route", () => {
    const crons = (JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")).crons ?? []) as { path: string }[];
    expect(crons.map((c) => c.path)).toContain("/api/cron/sweep-payments");
    for (const c of crons) expect(existsSync(join(ROOT, "app", c.path, "route.ts")), c.path).toBe(true);
  });
});
