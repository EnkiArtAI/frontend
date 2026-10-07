import { describe, it, expect, vi } from "vitest";
import { withStepUp } from "../../components/StepUpProvider";

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
