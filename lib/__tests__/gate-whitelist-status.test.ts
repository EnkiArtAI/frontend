import { describe, it, expect, afterEach, vi } from "vitest";
import { GET as gate } from "../../app/api/gate/route";

/**
 * SOC-8: GET /api/gate gains `whitelistActive`, the one piece of server
 * state BetaGate.tsx needs to know whether the role check still applies.
 * It mirrors lib/allowlist.ts's whitelistStageActive() exactly (same env
 * var, same truthiness), tested here against the real route handler, not a
 * mock of it — `team`'s existing behavior must be provably unchanged.
 */

afterEach(() => vi.unstubAllEnvs());

const req = (cookie?: string) => new Request("http://enki.test/api/gate", { headers: cookie ? { cookie } : {} });

describe("GET /api/gate — whitelistActive", () => {
  it("is false once the whitelist stage has ended (TEAM_ACCESS_CODE unset)", async () => {
    vi.stubEnv("TEAM_ACCESS_CODE", "");
    const res = await gate(req());
    expect(await res.json()).toEqual({ team: false, whitelistActive: false });
  });

  it("is true while the stage is active, even with no cookie", async () => {
    vi.stubEnv("TEAM_ACCESS_CODE", "beta-code");
    const res = await gate(req());
    expect(await res.json()).toEqual({ team: false, whitelistActive: true });
  });

  it("is true alongside a valid team cookie — team's own semantics are unchanged", async () => {
    vi.stubEnv("TEAM_ACCESS_CODE", "beta-code");
    const res = await gate(req("enki_team=beta-code"));
    expect(await res.json()).toEqual({ team: true, whitelistActive: true });
  });

  it("ignores a stale/wrong cookie while the stage is active: team false, whitelistActive still true", async () => {
    vi.stubEnv("TEAM_ACCESS_CODE", "beta-code");
    const res = await gate(req("enki_team=some-other-code"));
    expect(await res.json()).toEqual({ team: false, whitelistActive: true });
  });
});
