import { describe, it, expect, vi } from "vitest";

/**
 * The buyer's checkout is a straight line — intent → authorize → sign →
 * submit — and every failure must stop the line COLD. A submit that fires
 * without a signature, or a sign prompt for an intent the server refused,
 * is the kind of bug that ends with a wallet popup nobody can explain.
 * The signer is passed in, so it is a plain mock; everything else runs the
 * real code against a scripted fetch.
 */

const signMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-headers", () => ({
  sessionAuthHeaders: () => ({ "X-Session-Token": "test-session" }),
}));

import {
  authorizePaidGeneration,
  fetchGenerationQuote,
  fetchGenerationQuotes,
  toModelFamily,
  microToUsd,
  CheckoutError,
} from "@/lib/generation-checkout";

const REQ = { promptId: "p-1", modelId: "db00c518-ee31-4d12-b40a-f8130f8e605b", resolution: "2K" as const };

type Script = Record<string, { status: number; body: unknown }>;
let calls: string[] = [];

function scriptFetch(script: Script) {
  calls = [];
  // Reset lives HERE, not in beforeEach: with the shared beforeEach/afterEach
  // hooks in place, this vitest version fails the sign-cancellation test with
  // the mock's own error even though the code under test provably catches it
  // (bisected 2026-08-12 — hook-free, the identical test passes). Each test
  // calls scriptFetch first, so isolation is preserved.
  signMock.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url);
      calls.push(path);
      const hit = script[path];
      if (!hit) throw new Error(`unscripted fetch: ${path}`);
      return {
        ok: hit.status < 400,
        status: hit.status,
        json: async () => hit.body,
      } as Response;
    }),
  );
}


describe("the happy line", () => {
  it("runs intent → authorize → sign → submit, in that order, once each", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: { transaction: "dHg=" } },
      "/api/payments/generation/submit": { status: 200, body: { authorized: true } },
    });
    signMock.mockResolvedValue("c2lnbmVk");

    const out = await authorizePaidGeneration(REQ, signMock);
    expect(out).toEqual({ intentId: "i-1" });
    expect(calls).toEqual([
      "/api/payments/generation/intent",
      "/api/payments/generation/authorize",
      "/api/payments/generation/submit",
    ]);
    expect(signMock).toHaveBeenCalledTimes(1);
    expect(signMock).toHaveBeenCalledWith("dHg=");
  });
});

describe("every failure stops the line cold", () => {
  it("a refused intent never reaches authorize or the wallet", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 422, body: { error: "no artist wallet" } },
    });
    await expect(authorizePaidGeneration(REQ, signMock)).rejects.toMatchObject({
      step: "intent",
      message: "no artist wallet",
    });
    expect(calls).toEqual(["/api/payments/generation/intent"]);
    expect(signMock).not.toHaveBeenCalled();
  });

  it("a failed authorize never opens the wallet", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 500, body: { error: "nope" } },
    });
    await expect(authorizePaidGeneration(REQ, signMock)).rejects.toMatchObject({ step: "authorize" });
    expect(signMock).not.toHaveBeenCalled();
  });

  it("a cancelled signature never reaches submit, and says nothing was charged", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: { transaction: "dHg=" } },
    });
    // A SYNCHRONOUS throw, deliberately: this vitest's spy tracking reports a
    // rejected promise returned from a mock as a test failure even when the
    // code under test awaits and catches it (verified — the caught error was
    // the correct CheckoutError and the test still went red). To an `await`
    // caller a sync throw and a rejection are indistinguishable, so the
    // semantics under test are identical.
    signMock.mockImplementation(() => {
      throw new Error("User rejected the request");
    });

    const err = await authorizePaidGeneration(REQ, signMock).catch((e) => e as CheckoutError);
    expect(err).toBeInstanceOf(CheckoutError);
    expect((err as CheckoutError).step).toBe("sign");
    // Literally true at every step of this flow — and the one sentence the
    // buyer needs when they change their mind in the wallet.
    expect((err as CheckoutError).message).toMatch(/nothing was charged/i);
    expect(calls).not.toContain("/api/payments/generation/submit");
  });

  it("a refusal from the signer itself reaches the buyer word for word", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: { transaction: "dHg=" } },
    });
    signMock.mockImplementation(() => {
      throw new CheckoutError("sign", "Connect the wallet you signed in with");
    });
    await expect(authorizePaidGeneration(REQ, signMock)).rejects.toMatchObject({
      step: "sign",
      message: "Connect the wallet you signed in with",
    });
    expect(calls).not.toContain("/api/payments/generation/submit");
  });

  it("an intent with no id is a refusal, not an undefined ride-along", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: {} } },
    });
    await expect(authorizePaidGeneration(REQ, signMock)).rejects.toMatchObject({ step: "intent" });
    expect(calls).toHaveLength(1);
  });
});

describe("the quote never invents a price", () => {
  it("maps the server breakdown into display dollars", async () => {
    scriptFetch({
      "/api/payments/generation/quote": {
        status: 200,
        body: {
          quote: {
            expiresAt: "2026-08-12T12:00:00Z",
            breakdown: { totalAmount: "1182000", networkFee: "5000", artistAmount: "1000000" },
            appliedRule: null,
          },
        },
      },
    });
    const q = await fetchGenerationQuote(REQ);
    expect(q).toMatchObject({ totalUsd: "1.182", networkFeeUsd: "0.005", artistUsd: "1.00" });
  });

  it("returns null on refusal or network failure — the button greys, no fake number", async () => {
    scriptFetch({ "/api/payments/generation/quote": { status: 401, body: { error: "auth" } } });
    expect(await fetchGenerationQuote(REQ)).toBeNull();

    signMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchGenerationQuote(REQ)).toBeNull();
  });
});

describe("many quotes in one request", () => {
  const Q = (total: string) => ({
    expiresAt: "2026-10-02T12:00:00Z",
    breakdown: { totalAmount: total, networkFee: "0", artistAmount: "0" },
    appliedRule: null,
  });

  it("answers each option in order, with null where the server gave none", async () => {
    let sent: unknown = null;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return { ok: true, status: 200, json: async () => ({ quotes: [Q("147400"), { error: "free" }, Q("13200")] }) } as Response;
    }));
    const out = await fetchGenerationQuotes([REQ, REQ, REQ]);
    expect(sent).toEqual({ items: [REQ, REQ, REQ] });
    expect(out.map((q) => q?.totalUsd ?? null)).toEqual(["0.147", null, "0.013"]);
    expect(out[0]?.totalMicro).toBe(147400);
  });

  it("invents nothing on a failed request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response));
    expect(await fetchGenerationQuotes([REQ, REQ])).toEqual([null, null]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchGenerationQuotes([REQ])).toEqual([null]);
  });
});

describe("display helpers", () => {
  it("slugs display names onto pricing keys", () => {
    expect(toModelFamily("Nano Banana Pro")).toBe("nano-banana-pro");
    expect(toModelFamily("GPT-Image-2 (coming soon)")).toBe("gpt-image-2");
    expect(toModelFamily("Seedream 5.0 lite (coming soon)")).toBe("seedream-5-0-lite");
  });

  it("shows whole cents as two decimals and the half-cent fee as three", () => {
    expect(microToUsd("1180000")).toBe("1.18");
    expect(microToUsd("5000")).toBe("0.005");
    expect(microToUsd("garbage")).toBe("0.00");
  });
});
