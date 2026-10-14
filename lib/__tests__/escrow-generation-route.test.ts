import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  events: [] as string[], after: [] as (() => Promise<unknown>)[],
  filters: [] as unknown[][], paid: true, userId: "11111111-1111-4111-8111-111111111111" as string | null,
  claim: vi.fn(), deliver: vi.fn(), fail: vi.fn(), advance: vi.fn(), record: vi.fn(),
  provider: vi.fn(), put: vi.fn(), imageCheck: vi.fn(), refs: vi.fn(), release: vi.fn(),
}));
const INTENT = "22222222-2222-4222-8222-222222222222";
const GENERATION = "33333333-3333-4333-8333-333333333333";
const OWNER = "ExampleCanonicalSessionOwner";
const IMAGE = "https://enki.public.blob.vercel-storage.com/generations/fixture.png";
const db = {
  from: () => {
    const q = {
      select: () => q,
      eq: (key: string, value: unknown) => { state.filters.push([key, value]); return q; },
      ilike: (key: string, value: unknown) => { state.filters.push([key, value]); return q; },
      maybeSingle: async () => ({ data: state.paid ? {
        model_id: "model-one", model_family: "gpt-image-2", resolution: "2K", quality: null,
        boost: false, reference_image_count: 0, prompt_id: null, artist_amount_micro: 0,
      } : null, error: null }),
    };
    return q;
  },
};
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: (task: unknown) => { if (typeof task === "function") state.after.push(task as () => Promise<unknown>); },
}));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db, getSupabaseServerClientSafe: () => db }));
vi.mock("@/lib/auth", () => ({
  requireAuth: vi.fn(async () => ({ walletAddress: OWNER, userId: OWNER })),
  authRefusal: () => new Response("", { status: 401 }), checkRateLimit: () => true,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRequestRateLimit: () => ({ allowed: true }), rateLimitKey: () => "key", rateLimitResponse: () => new Response("", { status: 429 }),
}));
vi.mock("@/lib/moderation", () => ({ moderate: async () => ({ allowed: true }), screenFirst: () => null, CLIENT_BLOCK_MESSAGE: "Refused" }));
vi.mock("@/lib/moderation/prompt-check", () => ({
  checkPrompt: async () => ({ verdict: "clear" }), NOT_CHECKED: { verdict: "clear" }, textValues: () => ({}),
}));
vi.mock("@/lib/generation/models", () => ({
  resolveModel: async () => ({ id: "model-one", name: "GPT Image 2", supportsQuality: false, supportsResolution: true, maxRefs: 0 }),
  chooseRoute: async () => ({ provider: "openai", providerModel: "real-server-model" }),
}));
vi.mock("@/lib/generation/model-family", () => ({ toModelFamily: () => "gpt-image-2" }));
vi.mock("@/lib/payments/generation-settings", () => ({ settingMismatch: () => null }));
vi.mock("@/lib/payments/escrow/server-claims", () => ({
  claimGenerationEscrowUnit: (...args: unknown[]) => state.claim(...args),
  deliverGenerationEscrowUnit: (...args: unknown[]) => state.deliver(...args),
  failGenerationEscrowUnit: (...args: unknown[]) => state.fail(...args),
}));
vi.mock("@/lib/payments/escrow/server-chain", () => {
  class EscrowPaymentError extends Error { constructor(readonly status: number, message: string) { super(message); } }
  return { EscrowPaymentError, escrowServerChain: () => ({ cluster: "solana-devnet" }) };
});
vi.mock("@/lib/payments/escrow/server-lifecycle", () => ({ advanceGenerationEscrow: (...args: unknown[]) => state.advance(...args) }));
vi.mock("@/lib/generation/record", () => {
  class GenerationRecordError extends Error { constructor(readonly reason = "fixture") { super("fixture"); } }
  return {
    GenerationRecordError, recordGeneration: (...args: unknown[]) => state.record(...args),
    resolveRecordingUserId: async () => state.userId,
    recordGenerationReferences: vi.fn(async () => {}), recordGenerationRenditions: vi.fn(async () => {}),
    recordGenerationFailure: vi.fn(async () => {}),
  };
});
vi.mock("@/backend/services/openai-image-generation", () => ({ generateImagesWithOpenAI: (...args: unknown[]) => state.provider(...args) }));
vi.mock("@/backend/services/gemini-image-generation", () => ({ generateImagesWithGemini: (...args: unknown[]) => state.provider(...args) }));
vi.mock("@/backend/services/wavespeed-image-generation", () => ({ generateImagesWithWaveSpeed: (...args: unknown[]) => state.provider(...args) }));
vi.mock("@/lib/moderation-enforcement", () => ({ childSafetyScore: () => null, recordModerationEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/moderation/image-case", () => ({ recordImageCase: vi.fn(async () => {}) }));
vi.mock("@/lib/moderation/image-check-bytes", async importOriginal => ({
  ...await importOriginal<typeof import("../moderation/image-check-bytes")>(),
  checkImageBytes: (...args: unknown[]) => state.imageCheck(...args),
  heldBack: (value: { verdict: string }) => ["blocked", "child_safety", "unavailable"].includes(value.verdict),
  isLink: (value: string) => value.startsWith("https:"), dataUrlBytes: () => null,
  IMAGE_REFUSED: "This image cannot be delivered.", IMAGE_UNCHECKED: "This image could not be checked.",
}));
vi.mock("@/lib/generation/derivative-store", () => ({
  putDurably: (...args: unknown[]) => state.put(...args), storeDeadline: (start: number) => start + 285_000,
  removeStored: vi.fn(async () => {}),
}));
vi.mock("@/lib/generation/concurrency", () => ({
  acquireSlot: async () => ({ allowed: true, slotId: "slot-one" }), releaseSlot: (...args: unknown[]) => state.release(...args),
}));
vi.mock("@/lib/generation/reference-images", () => ({ storeReferenceImages: (...args: unknown[]) => state.refs(...args) }));

import { POST } from "../../app/api/generate-image/route";
import { EscrowPaymentError } from "@/lib/payments/escrow/server-chain";
import { GenerationRecordError, recordGenerationFailure } from "@/lib/generation/record";

function request(overrides: Record<string, unknown> = {}, session = true) {
  return new NextRequest("http://enki.test/api/generate-image", {
    method: "POST", headers: { "Content-Type": "application/json", ...(session ? { "X-Session-Token": "fixture-session" } : {}) },
    body: JSON.stringify({ intentId: INTENT, unitIndex: 0, prompt: "A blue bird", ...overrides }),
  });
}
beforeEach(() => {
  vi.clearAllMocks(); state.events = []; state.after = []; state.filters = []; state.paid = true;
  state.userId = "11111111-1111-4111-8111-111111111111";
  state.claim.mockImplementation(async (_db, _chain, fields) => {
    state.events.push("claim"); return { ...fields, claimToken: "44444444-4444-4444-8444-444444444444" };
  });
  state.provider.mockImplementation(async () => {
    state.events.push("provider"); return { success: true, imageBuffers: [Buffer.from("fixture")], metadata: { model: "real-server-model" } };
  });
  state.put.mockResolvedValue(IMAGE);
  state.imageCheck.mockImplementation(async () => { state.events.push("image-check"); return { verdict: "clear" }; });
  state.record.mockImplementation(async () => { state.events.push("record"); return { generationId: GENERATION, imageId: null }; });
  state.deliver.mockImplementation(async () => { state.events.push("deliver"); });
  state.fail.mockResolvedValue(undefined); state.advance.mockResolvedValue({ pending: false }); state.refs.mockResolvedValue([]);
  vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("The paid image route admits and delivers one escrow unit", () => {
  it.each([undefined, -1, 24, 0.5, "0", null])("refuses malformed unitIndex %s before payment or provider", async (unitIndex) => {
    expect((await POST(request({ unitIndex }))).status).toBe(400);
    expect(state.claim).not.toHaveBeenCalled(); expect(state.provider).not.toHaveBeenCalled();
  });
  it("requires an authenticated session and an actual users.id before any claim", async () => {
    expect((await POST(request({}, false))).status).toBe(401);
    state.userId = null;
    expect((await POST(request())).status).toBe(401);
    expect(state.claim).not.toHaveBeenCalled(); expect(state.provider).not.toHaveBeenCalled();
  });
  it("reads only the session owner's quote and ignores body ownership and delivered count", async () => {
    const response = await POST(request({ userId: "intruder", buyerWallet: "intruder", k: 24, unitIndex: 3 }));
    expect(response.status).toBe(200);
    expect(state.filters).toContainEqual(["buyer_wallet", OWNER]);
    expect(state.claim).toHaveBeenCalledWith(db, expect.anything(), {
      intentId: INTENT, owner: OWNER, userId: state.userId, unitIndex: 3,
    });
    expect(state.provider.mock.calls[0][0]).toMatchObject({ modelVersion: "real-server-model", numImages: 1 });
  });
  it("records the verified server payment network regardless of a caller's chain field", async () => {
    const response = await POST(request({ chain: "base-sepolia" }));
    expect(response.status).toBe(200); expect(state.record.mock.calls[0][1]).toMatchObject({ chainKey: "solana-devnet" });
  });
  it("rejects another buyer's quote before the provider", async () => {
    state.paid = false;
    expect((await POST(request())).status).toBe(404);
    expect(state.claim).not.toHaveBeenCalled(); expect(state.provider).not.toHaveBeenCalled();
  });
  it("cannot run a provider for an already leased or delivered unit", async () => {
    state.claim.mockRejectedValue(new EscrowPaymentError(409, "Already claimed."));
    expect((await POST(request())).status).toBe(409);
    expect(state.provider).not.toHaveBeenCalled(); expect(state.fail).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
  });
  it("awaits durable accepted-image recording before delivery and returns the saved image", async () => {
    const response = await POST(request());
    expect(state.events).toEqual(["claim", "provider", "image-check", "record", "deliver"]);
    expect(state.record).toHaveBeenCalledWith(db, expect.objectContaining({ imageUrl: IMAGE, userId: state.userId }), { requireAcceptedImage: true });
    expect(state.deliver).toHaveBeenCalledWith(db, expect.objectContaining({ unitIndex: 0, owner: OWNER }), GENERATION);
    expect(await response.json()).toMatchObject({ imageUrl: IMAGE, generationId: GENERATION, paymentScheme: "escrow", reconciliationPending: false });
    expect(state.advance).not.toHaveBeenCalled();
    for (const task of state.after) await task();
    expect(state.advance).toHaveBeenCalledWith(db, expect.anything(), INTENT, OWNER);
  });
  it("waits for the recorder promise and never marks an image delivered prematurely", async () => {
    let finish!: (id: { generationId: string; imageId: string | null }) => void;
    state.record.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = POST(request());
    await vi.waitFor(() => expect(state.record).toHaveBeenCalledOnce());
    expect(state.deliver).not.toHaveBeenCalled();
    finish({ generationId: GENERATION, imageId: null });
    expect((await pending).status).toBe(200);
    expect(state.deliver).toHaveBeenCalledOnce();
  });
  it("fails only its matched claim on provider failure", async () => {
    state.provider.mockResolvedValue({ success: false, error: "fixture vendor failure" });
    expect((await POST(request({ unitIndex: 2 }))).status).toBe(500);
    expect(state.fail).toHaveBeenCalledWith(db, expect.objectContaining({ unitIndex: 2, claimToken: expect.any(String), owner: OWNER }));
    expect(state.record).not.toHaveBeenCalled(); expect(state.deliver).not.toHaveBeenCalled();
  });
  it("cannot deliver or bill an unstored image even when the bytes would fit inline", async () => {
    state.put.mockResolvedValue(null);
    const response = await POST(request()); expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/nothing was charged/i);
    expect(state.record).not.toHaveBeenCalled(); expect(state.deliver).not.toHaveBeenCalled(); expect(state.fail).toHaveBeenCalledOnce();
  });
  it("does not record or deliver an image that moderation refuses", async () => {
    state.imageCheck.mockResolvedValue({ verdict: "blocked" });
    expect((await POST(request())).status).toBe(422);
    expect(state.record).not.toHaveBeenCalled(); expect(state.deliver).not.toHaveBeenCalled(); expect(state.fail).toHaveBeenCalledOnce();
  });
  it("does not deliver a generation whose accepted-image record failed", async () => {
    state.record.mockRejectedValue(new GenerationRecordError("generations insert: 23514 provider"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(request());
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ refundPending: true });
    expect(state.deliver).not.toHaveBeenCalled(); expect(state.fail).toHaveBeenCalledOnce();
    // The step that refused reaches the log and generation_failures; the user keeps the fixed sentence.
    expect(log).toHaveBeenCalledWith("[generate]", "record: generations insert: 23514 provider");
    expect(recordGenerationFailure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ error: "record: generations insert: 23514 provider" }));
    log.mockRestore();
  });
  it("retries a lost delivery acknowledgement once with the same generation and claim", async () => {
    state.deliver.mockRejectedValueOnce(new Error("fixture lost response")).mockResolvedValue(undefined);
    expect((await POST(request())).status).toBe(200);
    expect(state.deliver).toHaveBeenCalledTimes(2);
    expect(state.deliver.mock.calls[0]).toEqual(state.deliver.mock.calls[1]);
    expect(state.fail).not.toHaveBeenCalled();
  });
  it("keeps the saved image after ambiguous delivery and reports reconciliation pending", async () => {
    state.deliver.mockRejectedValue(new Error("fixture RPC timeout"));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ imageUrl: IMAGE, generationId: GENERATION, reconciliationPending: true });
    expect(state.fail).toHaveBeenCalledOnce();
    for (const task of state.after) await task();
    expect(state.advance).toHaveBeenCalledOnce();
  });
});
