import { describe, it, expect, vi } from "vitest";

/**
 * Editor 2 (Node Creator) pays through the intent rail. Before, it posted a
 * paid model to /api/generate-image with no payment at all, got a 402 and
 * told the user to "top up your balance", which does not exist.
 */

vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "t" }) }));

import { generateWithModel } from "@/components/enki-shell/generation";

const GPT = { id: "14b3db65-0000-4000-8000-000000000000", name: "GPT-Image-2", price: 0.17 };

type Call = { path: string; body: Record<string, unknown>; headers: Record<string, string> };
let calls: Call[] = [];

function scriptFetch(script: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = String(url);
      calls.push({ path, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      if (!(path in script)) throw new Error(`unscripted fetch: ${path}`);
      return { ok: true, status: 200, json: async () => script[path] } as Response;
    }),
  );
}

const PAID = {
  "/api/payments/generation/intent": { intent: { id: "i-1" } },
  "/api/payments/generation/authorize": { transaction: "dHg=" },
  "/api/payments/generation/submit": { authorized: true },
  "/api/generate-image": { imageUrl: "https://img/1.png" },
};

describe("a paid model in the editor", () => {
  it("holds a payment for the buyer's own prompt, then generates with the intent", async () => {
    scriptFetch(PAID);
    const sign = vi.fn(async () => "c2lnbmVk");
    const out = await generateWithModel({ prompt: "a cat", resolution: "4K", model: GPT, quality: "high", sign });

    expect(out).toEqual({ url: "https://img/1.png" });
    expect(calls.map((c) => c.path)).toEqual([
      "/api/payments/generation/intent",
      "/api/payments/generation/authorize",
      "/api/payments/generation/submit",
      "/api/generate-image",
    ]);
    expect(sign).toHaveBeenCalledWith("dHg=");
    expect(calls[0].body).toEqual({ modelId: GPT.id, resolution: "4K", boost: false, quality: "high" });
    const gen = calls[3];
    expect(gen.body).toMatchObject({ intentId: "i-1", modelIds: [GPT.id], quality: "high" });
    // The intent is bound to the session's buyer, so the session must travel.
    expect(gen.headers["X-Session-Token"]).toBe("t");
  });

  it("generates nothing when the buyer cancels in the wallet", async () => {
    scriptFetch(PAID);
    const sign = vi.fn(() => {
      throw new Error("User rejected the request");
    });
    const out = await generateWithModel({ prompt: "a cat", model: GPT, sign });
    expect(out).toMatchObject({ error: expect.stringMatching(/nothing was charged/) });
    expect(calls.map((c) => c.path)).not.toContain("/api/generate-image");
    expect(calls.map((c) => c.path)).not.toContain("/api/payments/generation/submit");
  });
});

describe("a free model in the editor", () => {
  it("never opens a payment", async () => {
    scriptFetch({ "/api/generate-free": { imageUrl: "https://img/free.png" } });
    const sign = vi.fn();
    const out = await generateWithModel({ prompt: "a cat", model: { ...GPT, price: 0 }, sign });
    expect(out).toEqual({ url: "https://img/free.png" });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate-free"]);
    expect(sign).not.toHaveBeenCalled();
  });
});
