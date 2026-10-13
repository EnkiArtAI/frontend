import { afterEach, describe, it, expect, vi } from "vitest";

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
  resumePaidGeneration,
  fetchFreeGenerationQuota,
  fetchGenerationQuote,
  fetchGenerationQuotes,
  PromptUnavailable,
  toModelFamily,
  microToUsd,
  CheckoutError,
  CONFIRM_WAITS_MS,
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
      "/api/payments/generation/authorize": { status: 200, body: { intentId: "i-1", transaction: "dHg=", units: 1, paymentScheme: "escrow" } },
      "/api/payments/generation/submit": { status: 200, body: { intentId: "i-1", paymentScheme: "escrow", state: "funded", funded: true } },
    });
    signMock.mockResolvedValue("c2lnbmVk");

    const out = await authorizePaidGeneration(REQ, signMock);
    expect(out).toEqual({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "funded", signedTransaction: "c2lnbmVk" });
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
      "/api/payments/generation/authorize": { status: 200, body: { intentId: "i-1", transaction: "dHg=", units: 1, paymentScheme: "escrow" } },
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
      "/api/payments/generation/authorize": { status: 200, body: { intentId: "i-1", transaction: "dHg=", units: 1, paymentScheme: "escrow" } },
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

describe("the quote of a prompt that is not for sale", () => {
  it("says so, instead of the null that keeps a button waiting", async () => {
    scriptFetch({ "/api/payments/generation/quote": { status: 404, body: { error: "Prompt not found" } } });
    await expect(fetchGenerationQuote(REQ)).rejects.toBeInstanceOf(PromptUnavailable);
    await expect(fetchGenerationQuote(REQ)).rejects.toThrow("This prompt is no longer available.");
  });

  it("is only that answer: every other refusal still reads as no quote yet", async () => {
    for (const status of [400, 401, 422, 429, 500]) {
      scriptFetch({ "/api/payments/generation/quote": { status, body: { error: "no" } } });
      expect(await fetchGenerationQuote(REQ)).toBeNull();
    }
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

it("the current buyer shows an unavailable prompt before pricing it and does not retry its quote", async () => {
  const { readSource } = await import("@/lib/__tests__/_read-source"); const { join } = await import("node:path");
  const model = readSource(join(__dirname, "..", "..", "components", "image-view", "useImageViewModel.ts"));
  expect(model).toContain('if (quote.unavailable) return { label: "No longer available", why: "This prompt is no longer available" };');
  expect(model.indexOf('if (quote.unavailable)')).toBeLessThan(model.indexOf('!setup.model.free && !quote.quote'));
  expect(readSource(join(__dirname, "..", "..", "hooks", "useComposerQuote.ts"))).toContain('retry: false,');
});

describe("one funded escrow per click", () => {
  const funded = { intentId: "i-1", paymentScheme: "escrow", state: "funded", funded: true };
  const prepared = (units: number) => ({ intentId: "i-1", transaction: "dHg=", units, paymentScheme: "escrow" });
  it("signs once for every paid unit and waits for a funded bank receipt", async () => {
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      bodies.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} });
      const body = path.endsWith("/intent") ? { intent: { id: "i-1" } } : path.endsWith("/authorize") ? prepared(4) :
        path.endsWith("/submit") ? { ...funded, state: "submitted", funded: false } : funded;
      return { ok: true, json: async () => body } as Response;
    }));
    const sign = vi.fn(async () => "signed-original");
    expect(await authorizePaidGeneration(REQ, sign, 4)).toMatchObject({ units: 4, state: "funded" });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(bodies.find(call => call.path.endsWith("/authorize"))?.body).toEqual({ intentId: "i-1", units: 4 });
    expect(bodies.at(-1)?.path).toBe("/api/payments/generation/status?intentId=i-1");
  });
  it("an uncertain submit retains its original intent and exact signed wire", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: prepared(1) },
    });
    signMock.mockResolvedValue("signed-original");
    const error = await authorizePaidGeneration(REQ, signMock).catch(error => error as CheckoutError);
    expect(error).toMatchObject({ step: "submit", payment: { intentId: "i-1", units: 1, state: "uncertain", signedTransaction: "signed-original" } });
    if (!(error instanceof CheckoutError)) throw new Error("Expected a pending CheckoutError");
    expect(error.message).not.toMatch(/nothing was charged|not charged/i);
    expect(calls.filter(path => path.endsWith("/intent"))).toHaveLength(1);
  });
  it("a prepared retry resubmits only the original wire without another wallet prompt or intent", async () => {
    const recorded: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      recorded.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { ok: true, json: async () => path.includes("/status?") ? { ...funded, state: "prepared", funded: false } : funded } as Response;
    }));
    const original = { intentId: "i-1", units: 4, paymentScheme: "escrow" as const, state: "uncertain" as const, signedTransaction: "original-wire" };
    expect(await resumePaidGeneration(original)).toMatchObject({ intentId: "i-1", units: 4, state: "funded" });
    expect(recorded).toEqual([
      { path: "/api/payments/generation/status?intentId=i-1", body: undefined },
      { path: "/api/payments/generation/submit", body: { intentId: "i-1", signedTransaction: "original-wire" } },
    ]);
  });
  describe("a deposit on its way to the chain (Kev's first browser payment, 2026-10-13)", () => {
    const submitted = { ...funded, state: "submitted", funded: false };
    const STATUS = "/api/payments/generation/status?intentId=i-1";
    const total = CONFIRM_WAITS_MS.reduce((a, b) => a + b, 0);
    /** Status answers, in order; the last one repeats. */
    const answers = (...states: Array<Record<string, unknown>>) => {
      let asked = 0;
      calls = [];
      vi.stubGlobal("fetch", vi.fn(async (path: string) => {
        calls.push(String(path));
        const body = path.endsWith("/intent") ? { intent: { id: "i-1" } } : path.endsWith("/authorize") ? prepared(1)
          : path.endsWith("/submit") ? submitted : states[Math.min(asked++, states.length - 1)];
        return { ok: true, status: 200, json: async () => body } as Response;
      }));
    };
    const asked = () => calls.filter((path) => path === STATUS).length;
    afterEach(() => vi.useRealTimers());

    it("is asked about again until its receipt is there, and then the order goes on", async () => {
      vi.useFakeTimers();
      answers(submitted, submitted, funded);
      const done = authorizePaidGeneration(REQ, vi.fn(async () => "signed-original"));
      // Asked once at once (unconfirmed), again after the first wait (unconfirmed), and after the second: funded.
      await vi.advanceTimersByTimeAsync(CONFIRM_WAITS_MS[0] + CONFIRM_WAITS_MS[1] - 1);
      expect(asked()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await done).toMatchObject({ intentId: "i-1", state: "funded", signedTransaction: "signed-original" });
      expect(asked()).toBe(3);
      expect(calls.filter((path) => path.endsWith("/intent") || path.endsWith("/submit"))).toHaveLength(2);
    });

    it("stays pending, never paid, when no receipt comes within the waits", async () => {
      vi.useFakeTimers();
      answers(submitted);
      const failed = resumePaidGeneration({ intentId: "i-1", units: 4, paymentScheme: "escrow", state: "submitted" }).catch((e) => e as CheckoutError);
      await vi.advanceTimersByTimeAsync(total);
      const error = await failed;
      expect(error).toMatchObject({ step: "status", payment: { state: "submitted", intentId: "i-1" } });
      expect((error as CheckoutError).message).toBe("Your payment is still being checked. Check its status before making another payment.");
      expect(asked()).toBe(1 + CONFIRM_WAITS_MS.length);
      expect(total).toBe(30_000);
    });

    it("stops asking the moment the deposit has an answer", async () => {
      vi.useFakeTimers();
      answers(submitted, { ...funded, state: "expired", funded: false });
      const failed = resumePaidGeneration({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "submitted" }).catch((e) => e as CheckoutError);
      await vi.advanceTimersByTimeAsync(total);
      expect(await failed).toMatchObject({ payment: { state: "expired" } });
      expect(asked()).toBe(2);
    });

    it("a prepared, unsigned deposit is an answer too: nothing is waited for", async () => {
      answers({ ...funded, state: "prepared", funded: false });
      await expect(resumePaidGeneration({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "prepared" })).rejects.toMatchObject({ payment: { state: "prepared" } });
      expect(asked()).toBe(1);
    });

    it("a status read that fails while waiting leaves the payment pending with its identity", async () => {
      vi.useFakeTimers();
      let n = 0;
      vi.stubGlobal("fetch", vi.fn(async () => (++n === 1
        ? { ok: true, status: 200, json: async () => submitted }
        : { ok: false, status: 503, json: async () => ({}) }) as Response));
      const failed = resumePaidGeneration({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "submitted", signedTransaction: "wire" }).catch((e) => e as CheckoutError);
      await vi.advanceTimersByTimeAsync(total);
      expect(await failed).toMatchObject({ step: "status", payment: { intentId: "i-1", state: "submitted", signedTransaction: "wire" } });
      expect(n).toBe(2);
    });
  });
  it.each([
    { ...funded, intentId: "another-intent" },
    { ...funded, state: "submitted" },
    { ...funded, paymentScheme: "nonce" },
  ])("rejects a mismatched or incoherent funded receipt", async body => {
    scriptFetch({ "/api/payments/generation/status?intentId=i-1": { status: 200, body } });
    await expect(resumePaidGeneration({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "submitted" })).rejects.toBeInstanceOf(CheckoutError);
  });
  it("retains expired payment identity and does not silently start a replacement", async () => {
    scriptFetch({ "/api/payments/generation/status?intentId=i-1": { status: 200, body: { ...funded, state: "expired", funded: false } } });
    await expect(resumePaidGeneration({ intentId: "i-1", units: 1, paymentScheme: "escrow", state: "submitted" })).rejects.toMatchObject({ payment: { intentId: "i-1", state: "expired" } });
    expect(calls).toHaveLength(1);
  });
  it.each([0, 25, 1.5])("refuses invalid batch size %s without creating a payment", async units => {
    scriptFetch({});
    await expect(authorizePaidGeneration(REQ, signMock, units)).rejects.toMatchObject({ step: "intent" });
    expect(calls).toEqual([]);
  });
  it("a mismatched prepared unit count never reaches the wallet", async () => {
    scriptFetch({
      "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
      "/api/payments/generation/authorize": { status: 200, body: prepared(1) },
    });
    await expect(authorizePaidGeneration(REQ, signMock, 4)).rejects.toMatchObject({ step: "authorize" });
    expect(signMock).not.toHaveBeenCalled();
  });
});

describe("the one baseline free image per day", () => {
  it("reads the server allowance and never assigns it to a premium model", async () => {
    const freeQuota = { used: 0, limit: 1, remaining: 1, exhausted: false, resetsAt: "2026-10-13T00:00:00Z" };
    scriptFetch({ "/api/generate-free/quota": { status: 200, body: { freeQuota } } });
    expect(await fetchFreeGenerationQuota()).toEqual(freeQuota);
  });
  it.each([
    { used: 0, limit: 2, remaining: 2, exhausted: false, resetsAt: "tomorrow" },
    { used: 1, limit: 1, remaining: 1, exhausted: false, resetsAt: "tomorrow" },
    { used: 1, limit: 1, remaining: 0, exhausted: false, resetsAt: "tomorrow" },
  ])("an invalid allowance stays unknown", async freeQuota => {
    scriptFetch({ "/api/generate-free/quota": { status: 200, body: { freeQuota } } });
    expect(await fetchFreeGenerationQuota()).toBeNull();
  });
});

it("rejects duplicate or out-of-range status units before any generation can be resumed", async () => {
  const pending = { unit_index: 0, state: "pending", generation_id: null };
  for (const units of [[pending, pending], [{ ...pending, unit_index: 4 }]]) {
    scriptFetch({ "/api/payments/generation/status?intentId=i-1": { status: 200, body: {
      intentId: "i-1", paymentScheme: "escrow", state: "funded", funded: true, units,
    } } });
    await expect(resumePaidGeneration({ intentId: "i-1", units: 4, paymentScheme: "escrow", state: "submitted" })).rejects.toBeInstanceOf(CheckoutError);
    expect(calls).toHaveLength(1);
  }
});

it("preserves public pending payment identity across reloads without retaining prompt content", async () => {
  const { storePendingEscrowPayments, readPendingEscrowPayments } = await import("@/lib/generation-checkout");
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const payment = { intentId: "i-1", units: 4, paymentScheme: "escrow" as const, state: "uncertain" as const,
    unitIndex: 0, signedTransaction: "original-wire", generationSubmitted: false, unitStatuses: [{ unit_index: 0, state: "pending" as const, generation_id: null }] };
  expect(storePendingEscrowPayments(storage, "user-a", [payment])).toBe(true);
  const restored = readPendingEscrowPayments(storage, "user-a");
  expect(restored).toEqual([{ intentId: "i-1", units: 4, paymentScheme: "escrow", state: "uncertain", unitIndex: 0, signedTransaction: "original-wire", generationSubmitted: false }]);
  expect(readPendingEscrowPayments(storage, "user-b")).toEqual([]);
  expect([...values.values()][0]).not.toContain("unitStatuses");
  storePendingEscrowPayments(storage, "user-b", null);
  expect(readPendingEscrowPayments(storage, "user-a")).toHaveLength(1);
  storePendingEscrowPayments(storage, "user-a", null);
  expect(readPendingEscrowPayments(storage, "user-a")).toEqual([]);
});

it("awaits the durable signed-payment checkpoint before the first submit fetch", async () => {
  const { storePendingEscrowPayments, readPendingEscrowPayments } = await import("@/lib/generation-checkout");
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const paths: string[] = [];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const checkpointEntered = new Promise<void>(resolve => { entered = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    paths.push(path);
    const body = path.endsWith("/intent") ? { intent: { id: "i-1" } } : path.endsWith("/authorize")
      ? { intentId: "i-1", transaction: "unsigned", units: 4, paymentScheme: "escrow" }
      : { intentId: "i-1", paymentScheme: "escrow", state: "funded", funded: true };
    return { ok: true, json: async () => body } as Response;
  }));
  const checkout = authorizePaidGeneration(REQ, vi.fn(async () => "original-signed-wire"), 4, async payment => {
    storePendingEscrowPayments(storage, "fixture-user", [{ ...payment, unitIndex: 0, generationSubmitted: false }]);
    entered();
    await gate;
  });
  await checkpointEntered;
  expect(paths).not.toContain("/api/payments/generation/submit");
  // This is what a new page can read even though submit has not finished or started.
  const reloaded = readPendingEscrowPayments(storage, "fixture-user");
  expect(reloaded[0]).toMatchObject({ intentId: "i-1", units: 4, signedTransaction: "original-signed-wire", state: "uncertain" });
  release();
  expect(await checkout).toMatchObject({ intentId: "i-1", state: "funded" });
  expect(paths.filter(path => path.endsWith("/submit"))).toHaveLength(1);
});

it("a failed checkpoint prevents submit and preserves the original signed payment for recovery", async () => {
  scriptFetch({
    "/api/payments/generation/intent": { status: 200, body: { intent: { id: "i-1" } } },
    "/api/payments/generation/authorize": { status: 200, body: { intentId: "i-1", transaction: "unsigned", units: 1, paymentScheme: "escrow" } },
  });
  await expect(authorizePaidGeneration(REQ, vi.fn(async () => "original-wire"), 1, async () => {
    throw new Error("storage unavailable");
  })).rejects.toMatchObject({ payment: { intentId: "i-1", signedTransaction: "original-wire" } });
  expect(calls).not.toContain("/api/payments/generation/submit");
});

it("read-only restored status inspection never submits even a prepared signed deposit", async () => {
  const { checkPaidGenerationStatus } = await import("@/lib/generation-checkout");
  scriptFetch({ "/api/payments/generation/status?intentId=i-1": { status: 200, body: { intentId: "i-1", paymentScheme: "escrow", state: "prepared", funded: false } } });
  expect(await checkPaidGenerationStatus({ intentId: "i-1", units: 4, paymentScheme: "escrow", state: "uncertain", signedTransaction: "original-wire" })).toMatchObject({ state: "prepared" });
  expect(calls).toEqual(["/api/payments/generation/status?intentId=i-1"]);
});
