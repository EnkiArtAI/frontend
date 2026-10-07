import { describe, it, expect, vi } from "vitest";

/**
 * Every surface starts a generation through runGeneration, and the selected
 * catalogue entry alone decides the route. It used to be decided by price,
 * by prompt type, or by a null model falling through to the free route, and
 * each of those rendered Flux for a user who had picked something else.
 */

vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "t" }) }));

import { runGeneration } from "@/lib/generation/run-generation";
import { registerCdpEnsure } from "@/lib/cdp-bridge";
import type { CatalogueEntry } from "@/hooks/useModelLimits";

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
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = String(url);
    calls.push({ path, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    if (!(path in script)) throw new Error(`unscripted fetch: ${path}`);
    return { ok: true, status: 200, json: async () => script[path] } as Response;
  }));
}

const PAID = {
  "/api/payments/generation/intent": { intent: { id: "i-1" } },
  "/api/payments/generation/authorize": { transaction: "dHg=" },
  "/api/payments/generation/submit": { authorized: true },
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

  it("comes from both editors", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ROOT = join(__dirname, "..", "..");
    expect(readFileSync(join(ROOT, "components", "EnkiPromptEditor.tsx"), "utf8")).toMatch(/referenceImages: cardRefs\.length \? cardRefs : undefined,\s*authoring: true,/);
    expect(readFileSync(join(ROOT, "components", "enki-shell", "NodeCreator.tsx"), "utf8")).toMatch(/workflow: buildExportJSON\(\),\s*authoring: true,/);
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
    ]);
    expect(calls[0].body).toEqual({ promptId: "p-1", modelId: GPT.id, resolution: "4K", quality: "high", boost: false, referenceImageCount: 2 });
    expect(calls[3].body).toEqual({ intentId: "i-1", prompt: "a cat", variableValues: { animal: "fox" }, aspectRatio: "1:1", referenceImages: ["data:a", "data:b"] });
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
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/nothing was charged/) });
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
