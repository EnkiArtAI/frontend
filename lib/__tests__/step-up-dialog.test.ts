import { describe, it, expect, vi } from "vitest";
import { withStepUp, confirmAction } from "../../components/StepUpProvider";

/**
 * The client half of a step-up: a request runs as it is; only when the
 * server answers 401 { stepUp } does the dialog ask for a factor, and the
 * request runs once more with the token. A cancelled dialog sends nothing.
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("a guarded request", () => {
  it("runs once and asks nobody when no step-up is needed", async () => {
    const run = vi.fn(async () => json(200, { ok: true }));
    const ask = vi.fn();
    expect((await withStepUp("delete-work:x", run, ask)).status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
  });

  it("leaves a plain 401 alone", async () => {
    const ask = vi.fn();
    expect((await withStepUp("s", async () => json(401, { error: "Not signed in" }), ask)).status).toBe(401);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks with the server's factors and retries with the token", async () => {
    const run = vi.fn(async (h: Record<string, string>) => (h["X-StepUp-Token"] === "t1" ? json(200, {}) : json(401, { stepUp: true, factors: ["totp", "email"] })));
    const ask = vi.fn(async () => "t1");
    expect((await withStepUp("guardians", run, ask)).status).toBe(200);
    expect(ask).toHaveBeenCalledWith("guardians", ["totp", "email"]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("sends nothing more when the dialog is cancelled", async () => {
    const run = vi.fn(async () => json(401, { stepUp: true, factors: ["passkey"] }));
    expect((await withStepUp("s", run, async () => null)).status).toBe(401);
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("an action the server cannot see (a key export)", () => {
  const factors = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => json(status, body)));

  it("goes ahead at once for an account without 2FA", async () => {
    factors(200, { factors: [] });
    const ask = vi.fn();
    expect(await confirmAction("export", ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks the factor when there is one, and stops when the dialog is cancelled", async () => {
    factors(200, { factors: ["totp"] });
    expect(await confirmAction("export", async () => "t1")).toBe(true);
    expect(await confirmAction("export", async () => null)).toBe(false);
  });

  it("never goes ahead when the factors cannot be read", async () => {
    factors(503, { error: "down" });
    const ask = vi.fn();
    await expect(confirmAction("export", ask)).rejects.toThrow(/security settings/);
    expect(ask).not.toHaveBeenCalled();
  });
});
