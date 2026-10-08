import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Every Helius RPC call costs credits (CLAUDE.md: Kev approves every metered
 * call). A probe that reaches Helius must spend the approved budget, the
 * keyless CDN included, or the guard waves it through uncounted.
 */
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("the metered guard", () => {
  it("counts every Helius host and lets other hosts through", async () => {
    vi.stubEnv("METERED_BUDGET", "0");
    const passed: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => { passed.push(u); return new Response("ok"); });
    await import("../../scripts/metered-guard.mjs");
    await expect(fetch("https://mainnet.helius-rpc.com/?api-key=k")).rejects.toThrow(/budget is 0/);
    await expect(fetch("https://cdn.helius-rpc.com/cdn-cgi/image/width=1/https://x.test/a.png")).rejects.toThrow(/budget is 0/);
    await fetch("https://example.test/");
    expect(passed).toEqual(["https://example.test/"]);
  });
});
