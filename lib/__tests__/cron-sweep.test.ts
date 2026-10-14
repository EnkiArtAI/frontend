import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ sweep: vi.fn(), chain: vi.fn() }));
vi.mock("@/lib/payments/escrow/server-sweep", () => ({ sweepGenerationEscrows: mocks.sweep }));
vi.mock("@/lib/payments/escrow/server-chain", () => ({ escrowServerChain: mocks.chain }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ fixture: true }) }));
import { GET } from "../../app/api/cron/sweep-payments/route";
import { proxy } from "../../proxy";
const call = (auth?: string) => GET(new NextRequest("http://enki.test/api/cron/sweep-payments", { headers: auth ? { authorization: auth } : {} }));
beforeEach(() => { vi.clearAllMocks(); process.env.CRON_SECRET = "cron-secret";
  mocks.chain.mockReturnValue({ fixture: true }); mocks.sweep.mockResolvedValue({ checked: 3, pending: 1, closed: 1, alerts: 1 });
});
describe("escrow payment reconciliation cron", () => {
  it("runs the bounded escrow sweep for the scheduler", async () => {
    const response = await call("Bearer cron-secret"); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ checked: 3, pending: 1, closed: 1, alerts: 1 }); expect(mocks.sweep).toHaveBeenCalledTimes(1);
  });
  it("refuses wrong authentication before looking up chain credentials", async () => {
    for (const auth of [undefined, "Bearer wrong", "cron-secret", "Bearer cron-secretX"]) expect((await call(auth)).status).toBe(401);
    expect(mocks.chain).not.toHaveBeenCalled(); expect(mocks.sweep).not.toHaveBeenCalled();
  });
  it("stays shut without a configured cron secret", async () => {
    delete process.env.CRON_SECRET; expect((await call("Bearer ")).status).toBe(503); expect(mocks.chain).not.toHaveBeenCalled();
  });
  it("reports a payment deployment outage without revealing RPC credentials", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.chain.mockImplementation(() => { throw new Error("https://rpc.invalid/private-secret"); });
    const response = await call("Bearer cron-secret"); expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private-secret"); expect(JSON.stringify(logs.mock.calls)).not.toContain("private-secret"); logs.mockRestore();
  });
  it("remains reachable without a team cookie and every scheduled path exists", () => {
    process.env.TEAM_ACCESS_CODE = "team-code"; expect(proxy(new NextRequest("http://enki.test/api/cron/sweep-payments")).headers.get("x-middleware-next")).toBe("1");
    const root = join(__dirname, "..", ".."); const crons = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")).crons as {path: string}[];
    expect(crons.map(c => c.path)).toContain("/api/cron/sweep-payments"); for (const item of crons) expect(existsSync(join(root, "app", item.path, "route.ts"))).toBe(true);
  });
});
