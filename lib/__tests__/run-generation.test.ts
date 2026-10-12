import { describe, it, expect, vi } from "vitest";

/**
 * Every surface starts a generation through runGeneration, and the selected
 * catalogue entry alone decides the route. It used to be decided by price,
 * by prompt type, or by a null model falling through to the free route, and
 * each of those rendered Flux for a user who had picked something else.
 */

vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "t" }) }));

import { runGeneration, runGenerationBatch } from "@/lib/generation/run-generation";
import { registerCdpEnsure } from "@/lib/cdp-bridge";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import { REQUEST_MAX_BYTES, REFS_TOO_LARGE } from "@/lib/request-size";

const entry = (over: Partial<CatalogueEntry>): CatalogueEntry => ({
  id: "14b3db65-08e3-49a5-b8bb-57f6d5821099", name: "GPT-Image-2", price: 0.1, mediaType: "image",
  supportsQuality: true, maxResolution: "4K", ratios: ["1:1"], free: false, ...over,
});
const GPT = entry({});
const NANO = entry({ id: "db00c518-ee31-4d12-b40a-f8130f8e605b", name: "Nano Banana Pro", supportsQuality: false });
const FLUX = entry({ id: "fee61592-88fc-4235-b060-2fc76b49bf89", name: "Flux (free)", price: 0, supportsQuality: false, free: true });

type Call = { path: string; body: Record<string, unknown>; headers: Record<string, string> };
let calls: Call[] = [];

function scriptFetch(script: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {}, headers: (init?.headers ?? {}) as Record<string, string> });
    if (!(path in script)) throw new Error(`unscripted fetch: ${path}`);
    if (script[path] instanceof Error) throw script[path];
    return { ok: true, status: 200, json: async () => script[path] } as Response;
  }));
}

const PAID = {
  "/api/payments/generation/intent": { intent: { id: "i-1" } },
  "/api/payments/generation/authorize": { intentId: "i-1", transaction: "dHg=", units: 1, paymentScheme: "escrow" },
  "/api/payments/generation/submit": { intentId: "i-1", paymentScheme: "escrow", state: "funded", funded: true },
  "/api/payments/generation/cancel": { ok: true },
  "/api/generate-image": { imageUrl: "https://img/1.png" },
};
const BASE = { prompt: "a cat", aspectRatio: "1:1", resolution: "4K" as const };

describe("an artist's draft", () => {
  it("is marked as one on both routes, so no moderator reads it", async () => {
    scriptFetch(PAID);
    await runGeneration({ ...BASE, model: GPT, authoring: true }, vi.fn(async () => "c2lnbmVk"));
    expect(calls.find((c) => c.path === "/api/generate-image")?.body.authoring).toBe(true);
    scriptFetch({ "/api/generate-free": { imageUrl: "https://img/2.png" } });
    await runGeneration({ ...BASE, model: FLUX, authoring: true }, vi.fn());
    expect(calls[0].body.authoring).toBe(true);
  });
});

describe("no selection, no generation", () => {
  it("sends nothing at all without a resolved model", async () => {
    scriptFetch({});
    const sign = vi.fn();
    const out = await runGeneration({ ...BASE, model: undefined }, sign);
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/Pick a model/) });
    expect(calls).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("a paid model", () => {
  it("pays for exactly the selected settings, then sends only the content", async () => {
    scriptFetch(PAID);
    const sign = vi.fn(async () => "c2lnbmVk");
    const out = await runGeneration(
      { ...BASE, model: GPT, quality: "high", boost: false, referenceImages: ["data:a", "data:b"], promptId: "p-1", variableValues: { animal: "fox" } },
      sign,
    );
    expect(out).toMatchObject({ ok: true, imageUrl: "https://img/1.png" });
    expect(calls.map((c) => c.path)).toEqual([
      "/api/payments/generation/intent",
      "/api/payments/generation/authorize",
      "/api/payments/generation/submit",
      "/api/generate-image",
      "/api/payments/generation/cancel",
    ]);
    expect(calls[0].body).toEqual({ promptId: "p-1", modelId: GPT.id, resolution: "4K", quality: "high", boost: false, referenceImageCount: 2 });
    expect(calls[3].body).toEqual({ intentId: "i-1", unitIndex: 0, prompt: "a cat", variableValues: { animal: "fox" }, aspectRatio: "1:1", referenceImages: ["data:a", "data:b"] });
    expect(calls[3].headers["X-Session-Token"]).toBe("t");
  });

  it("sends boost only where the model has a faster host", async () => {
    // The toggle hides on a model without boost; a boost left on must not travel.
    scriptFetch(PAID);
    await runGeneration({ ...BASE, model: GPT, boost: true }, vi.fn(async () => "s"));
    expect(calls[0].body.boost).toBe(false);
    scriptFetch(PAID);
    await runGeneration({ ...BASE, model: entry({ boostAvailable: true }), boost: true }, vi.fn(async () => "s"));
    expect(calls[0].body.boost).toBe(true);
  });

  it("never sends a quality to a model without the lever", async () => {
    scriptFetch(PAID);
    await runGeneration({ ...BASE, model: NANO, quality: "high" }, vi.fn(async () => "s"));
    expect(calls[0].body.quality).toBeUndefined();
    expect(calls[0].body.modelId).toBe(NANO.id);
  });

  it("is paid even when its catalogue price reads 0: only the server's free flag makes it free", async () => {
    scriptFetch(PAID);
    await runGeneration({ ...BASE, model: entry({ price: 0 }) }, vi.fn(async () => "s"));
    expect(calls[0].path).toBe("/api/payments/generation/intent");
  });

  it("waits for an embedded wallet that can act and is on the session before it pays", async () => {
    scriptFetch(PAID);
    const ensure = vi.fn(async () => { expect(calls).toEqual([]); });
    registerCdpEnsure(ensure);
    try {
      await runGeneration({ ...BASE, model: GPT }, vi.fn(async () => "s"));
    } finally {
      registerCdpEnsure(null);
    }
    expect(ensure).toHaveBeenCalledWith({ attached: true });
  });

  it("generates nothing when the buyer cancels in the wallet", async () => {
    scriptFetch(PAID);
    const out = await runGeneration({ ...BASE, model: GPT }, vi.fn(() => { throw new Error("User rejected the request"); }));
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/nothing was charged/i) });
    expect(calls.map((c) => c.path)).not.toContain("/api/generate-image");
  });
});

describe("the free model", () => {
  it("goes to the free route with its id and the session, and never opens a payment", async () => {
    scriptFetch({ "/api/generate-free": { imageUrl: "https://img/free.png" } });
    const sign = vi.fn();
    const out = await runGeneration({ ...BASE, resolution: "2K", model: FLUX }, sign);
    expect(out).toMatchObject({ ok: true, imageUrl: "https://img/free.png" });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate-free"]);
    expect(calls[0].body).toMatchObject({ modelId: FLUX.id, prompt: "a cat", resolution: "2K" });
    expect(calls[0].headers["X-Session-Token"]).toBe("t");
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("a request too large to arrive", () => {
  // Vercel turns it away with a 413 before our route runs; a paid one would
  // meet that only after its payment was signed.
  const huge = ["data:image/webp;base64," + "A".repeat(REQUEST_MAX_BYTES)];

  it("is refused before the wallet is asked or a payment is opened", async () => {
    scriptFetch(PAID);
    const sign = vi.fn(async () => "s");
    const ensure = vi.fn(async () => {});
    registerCdpEnsure(ensure);
    try {
      expect(await runGeneration({ ...BASE, model: GPT, referenceImages: huge }, sign)).toEqual({ ok: false, phase: "prepare", error: REFS_TOO_LARGE });
    } finally {
      registerCdpEnsure(null);
    }
    expect(ensure).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("is refused on the free route too, unsent", async () => {
    scriptFetch({ "/api/generate-free": { imageUrl: "https://img/free.png" } });
    expect(await runGeneration({ ...BASE, model: FLUX, referenceImages: huge }, vi.fn())).toEqual({ ok: false, phase: "prepare", error: REFS_TOO_LARGE });
    expect(calls).toEqual([]);
  });

  it("is measured whole: a request that fits still goes", async () => {
    scriptFetch(PAID);
    await runGeneration({ ...BASE, model: GPT, referenceImages: ["data:image/webp;base64," + "A".repeat(REQUEST_MAX_BYTES / 2)] }, vi.fn(async () => "s"));
    expect(calls.some(call => call.path === "/api/generate-image")).toBe(true);
  });
});


describe("the failure phase of a generation", () => {
  it.each(["intent", "authorize", "submit"])("a network error in %s is still before generation", async (step) => {
    scriptFetch({ ...PAID, ["/api/payments/generation/" + step]: new Error("Connection lost") });
    const sign = vi.fn(async () => "signed");
    const out = await runGeneration({ ...BASE, model: GPT }, sign);
    expect(out).toMatchObject({ ok: false, phase: "authorization", error: expect.any(String) });
    expect(calls.map((c) => c.path)).not.toContain("/api/generate-image");
    expect(sign).toHaveBeenCalledTimes(step === "submit" ? 1 : 0);
  });

  it("the wallet setup can fail before any payment request", async () => {
    scriptFetch(PAID);
    registerCdpEnsure(async () => { throw new Error("Wallet unavailable"); });
    try {
      expect(await runGeneration({ ...BASE, model: GPT }, vi.fn())).toMatchObject({ ok: false, phase: "prepare" });
      expect(calls).toEqual([]);
    } finally { registerCdpEnsure(null); }
  });

  it("a signed request lost during generation has an uncertain outcome", async () => {
    scriptFetch({ ...PAID, "/api/generate-image": new Error("Connection lost") });
    expect(await runGeneration({ ...BASE, model: GPT }, vi.fn(async () => "signed"))).toMatchObject({ ok: false, phase: "generation" });
    expect(calls.some(call => call.path === "/api/generate-image")).toBe(true);
  });

  it("a free request lost during generation also records that phase", async () => {
    scriptFetch({ "/api/generate-free": new Error("Connection lost") });
    expect(await runGeneration({ ...BASE, model: FLUX }, vi.fn())).toMatchObject({ ok: false, phase: "generation" });
  });

  it("a successful response without an image came from the generation phase", async () => {
    scriptFetch({ ...PAID, "/api/generate-image": {} });
    expect(await runGeneration({ ...BASE, model: GPT }, vi.fn(async () => "signed"))).toMatchObject({ ok: false, phase: "generation", error: "No image returned" });
  });
});

describe("a batch is one paid click", () => {
  const authorise = (units: number) => ({ ...PAID, "/api/payments/generation/authorize": { intentId: "i-1", transaction: "dHg=", units, paymentScheme: "escrow" } });
  const requests = (count: number) => Array.from({ length: count }, () => ({ ...BASE, model: GPT }));
  it("four paid images use one escrow deposit, one signature and four unique server unit indexes", async () => {
    scriptFetch(authorise(4));
    const sign = vi.fn(async () => "signed");
    const outcomes = await runGenerationBatch(requests(4), sign);
    expect(outcomes.every(outcome => outcome.ok)).toBe(true);
    expect(calls.filter(call => call.path.endsWith("/intent"))).toHaveLength(1);
    expect(calls.find(call => call.path.endsWith("/authorize"))?.body).toEqual({ intentId: "i-1", units: 4 });
    expect(sign).toHaveBeenCalledTimes(1);
    const generated = calls.filter(call => call.path === "/api/generate-image");
    expect(generated.map(call => call.body.unitIndex)).toEqual([0, 1, 2, 3]);
    expect(generated.every(call => call.body.intentId === "i-1" && call.body.modelId === undefined)).toBe(true);
  });
  it("an explicit one-free plus three-paid selection keeps the chosen models and one paid deposit", async () => {
    scriptFetch({ ...authorise(3), "/api/generate-free": { imageUrl: "https://img/free.png" } });
    const outcomes = await runGenerationBatch([{ ...BASE, model: FLUX }, ...requests(3)], vi.fn(async () => "signed"));
    expect(outcomes).toHaveLength(4);
    expect(calls.filter(call => call.path === "/api/generate-free")).toHaveLength(1);
    expect(calls.find(call => call.path === "/api/generate-free")?.body.modelId).toBe(FLUX.id);
    expect(calls.find(call => call.path.endsWith("/intent"))?.body.modelId).toBe(GPT.id);
    expect(calls.find(call => call.path.endsWith("/authorize"))?.body.units).toBe(3);
    expect(calls.filter(call => call.path === "/api/generate-image").map(call => call.body.unitIndex)).toEqual([0, 1, 2]);
  });
  it("never auto-switches an exhausted or oversized free-model order to a paid model", async () => {
    scriptFetch({});
    const sign = vi.fn();
    expect((await runGenerationBatch(Array.from({ length: 4 }, () => ({ ...BASE, model: FLUX })), sign)).every(outcome => !outcome.ok)).toBe(true);
    expect(calls).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
  });
  it("refuses inconsistent paid terms or an oversized reference before signing or calling providers", async () => {
    scriptFetch({});
    await runGenerationBatch([{ ...BASE, model: GPT }, { ...BASE, model: NANO }], vi.fn());
    await runGenerationBatch([{ ...BASE, model: GPT }, { ...BASE, model: GPT, referenceImages: ["A".repeat(REQUEST_MAX_BYTES)] }], vi.fn());
    expect(calls).toEqual([]);
  });
  it("an ambiguous deposit blocks every provider and retains all unit indexes for same-intent resume", async () => {
    scriptFetch({ ...authorise(4), "/api/payments/generation/submit": new Error("lost response") });
    const pending = await runGenerationBatch(requests(4), vi.fn(async () => "original-wire"));
    expect(pending.every(outcome => !outcome.ok && outcome.payment?.intentId === "i-1" && !outcome.payment.generationSubmitted)).toBe(true);
    expect(calls.some(call => call.path.startsWith("/api/generate-"))).toBe(false);
    const payments = pending.map(outcome => outcome.payment!);
    expect(payments.map(payment => payment.unitIndex)).toEqual([0, 1, 2, 3]);
    scriptFetch({ ...authorise(4), "/api/payments/generation/status?intentId=i-1": PAID["/api/payments/generation/submit"] });
    const sign = vi.fn();
    const resumed = await runGenerationBatch(requests(4), sign, undefined, payments);
    expect(resumed.every(outcome => outcome.ok)).toBe(true);
    expect(sign).not.toHaveBeenCalled();
    expect(calls.some(call => call.path.endsWith("/intent") || call.path.endsWith("/authorize") || call.path.endsWith("/submit"))).toBe(false);
    expect(calls.filter(call => call.path === "/api/generate-image").map(call => call.body.unitIndex)).toEqual([0, 1, 2, 3]);
  });
  it("a lost generation response is reconciled, never requested or paid twice", async () => {
    scriptFetch({ ...PAID, "/api/generate-image": new Error("lost response") });
    const original = await runGeneration({ ...BASE, model: GPT }, vi.fn(async () => "signed"));
    expect(original).toMatchObject({ ok: false, phase: "generation", payment: { intentId: "i-1", generationSubmitted: true } });
    scriptFetch({ "/api/payments/generation/status?intentId=i-1": PAID["/api/payments/generation/submit"] });
    const sign = vi.fn();
    expect(await runGeneration({ ...BASE, model: GPT }, sign, original.payment)).toMatchObject({ ok: false, payment: { intentId: "i-1", generationSubmitted: true } });
    expect(calls.map(call => call.path)).toEqual(["/api/payments/generation/status?intentId=i-1", "/api/payments/generation/cancel"]);
    expect(sign).not.toHaveBeenCalled();
  });
  it("a provider HTTP refusal also preserves the funded deposit without claiming nothing was charged", async () => {
    scriptFetch(PAID);
    const fetchMock = vi.mocked(fetch);
    const ordinary = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => String(url) === "/api/generate-image" ? {
      ok: false, status: 502, json: async () => ({ error: "Provider unavailable" }),
    } as Response : ordinary(url, init));
    expect(await runGeneration({ ...BASE, model: GPT }, vi.fn(async () => "signed"))).toMatchObject({
      ok: false, status: 502, payment: { intentId: "i-1", state: "funded", generationSubmitted: true },
    });
  });
});

it("reconciles delivered and running units while requesting only never-started pending units", async () => {
  const units = [
    { unit_index: 0, state: "delivered", generation_id: "33333333-3333-4333-8333-333333333333", imageUrl: "https://img/already-delivered.png" },
    { unit_index: 1, state: "running", generation_id: null },
    { unit_index: 2, state: "pending", generation_id: null },
    { unit_index: 3, state: "failed", generation_id: null },
  ];
  scriptFetch({ ...PAID, "/api/payments/generation/status?intentId=i-1": { ...PAID["/api/payments/generation/submit"], units } });
  const resume = units.map(unit => ({ intentId: "i-1", units: 4, unitIndex: unit.unit_index,
    paymentScheme: "escrow" as const, state: "funded" as const, generationSubmitted: unit.state !== "pending" }));
  const sign = vi.fn();
  const outcomes = await runGenerationBatch(Array.from({ length: 4 }, () => ({ ...BASE, model: GPT })), sign, undefined, resume);
  expect(outcomes[0]).toMatchObject({ ok: true, imageUrl: "https://img/already-delivered.png" });
  expect(outcomes[1]).toMatchObject({ ok: false, payment: { unitIndex: 1, generationSubmitted: true } });
  expect(outcomes[2]).toMatchObject({ ok: true });
  expect(outcomes[3]).toMatchObject({ ok: false, error: expect.stringMatching(/unused payment is being refunded/) });
  expect(calls.filter(call => call.path === "/api/generate-image").map(call => call.body.unitIndex)).toEqual([2]);
  expect(calls.some(call => call.path.endsWith("/intent") || call.path.endsWith("/authorize") || call.path.endsWith("/submit"))).toBe(false);
  expect(sign).not.toHaveBeenCalled();
});

it("awaits unit payment checkpoints before any provider request and preserves sent flags across restore", async () => {
  scriptFetch(PAID);
  const checkpoints: unknown[] = [];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const providerCheckpointEntered = new Promise<void>(resolve => { entered = resolve; });
  const running = runGenerationBatch([{ ...BASE, model: GPT }], vi.fn(async () => "signed"), undefined, undefined, async payments => {
    checkpoints.push(payments.map(payment => ({ ...payment })));
    if (payments.some(payment => payment.generationSubmitted)) {
      entered();
      await gate;
    }
  });
  await providerCheckpointEntered;
  expect(calls.some(call => call.path === "/api/generate-image")).toBe(false);
  expect(checkpoints.at(-1)).toEqual([expect.objectContaining({ intentId: "i-1", unitIndex: 0, state: "funded", generationSubmitted: true })]);
  release();
  expect((await running)[0]).toMatchObject({ ok: true });
});

it("a disappeared catalogue entry during resume never discards the existing payment identity", async () => {
  scriptFetch({});
  const payment = { intentId: "i-1", units: 1, unitIndex: 0, paymentScheme: "escrow" as const, state: "funded" as const, generationSubmitted: true };
  expect(await runGeneration({ ...BASE, model: undefined }, vi.fn(), payment)).toMatchObject({ ok: false, payment: { intentId: "i-1", generationSubmitted: true } });
  expect(calls).toEqual([]);
});
