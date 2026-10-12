import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), prepare: vi.fn(), submit: vi.fn(), status: vi.fn(), advance: vi.fn(), chain: vi.fn(), db: {} }));
vi.mock("@/lib/auth", () => ({ requireAuth: mocks.auth, authRefusal: () => Response.json({ error: "Sign in to continue." }, { status: 401 }), checkRateLimit: () => true }));
vi.mock("@/lib/rate-limit", () => ({ checkRequestRateLimit: () => ({ allowed: true }), rateLimitKey: () => "fixture", rateLimitResponse: () => Response.json({}, { status: 429 }) }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => mocks.db }));
vi.mock("@/lib/payments/escrow/server-deposit", () => ({ prepareGenerationEscrow: mocks.prepare, submitGenerationEscrow: mocks.submit, generationEscrowStatus: mocks.status }));
vi.mock("@/lib/payments/escrow/server-lifecycle", () => ({ advanceGenerationEscrow: mocks.advance }));
vi.mock("@/lib/payments/escrow/server-chain", async importOriginal => ({ ...await importOriginal<typeof import("../escrow/server-chain")>(), escrowServerChain: mocks.chain }));
import { POST as authorize } from "../../../app/api/payments/generation/authorize/route";
import { POST as submit } from "../../../app/api/payments/generation/submit/route";
import { GET as status } from "../../../app/api/payments/generation/status/route";
import { POST as cancel } from "../../../app/api/payments/generation/cancel/route";
import { EscrowPaymentError } from "../escrow/server-chain";
const id = "00112233-4455-6677-8899-aabbccddeeff";
const req = (body: unknown) => new NextRequest("http://enki.test/api/payments/generation", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ userId: "session-id", walletAddress: "CaseExactSessionOwner" });
  mocks.chain.mockReturnValue({ fixture: true });
  mocks.prepare.mockResolvedValue({ intentId: id, transaction: "wire", units: 4, paymentScheme: "escrow" });
  mocks.submit.mockResolvedValue({ intentId: id, state: "submitted", funded: false, paymentScheme: "escrow" });
  mocks.status.mockResolvedValue({ intentId: id, state: "submitted", funded: false, paymentScheme: "escrow" });
  mocks.advance.mockResolvedValue({ batch: { state: "closing" } });
});
describe("escrow payment route boundary", () => {
  it("authenticates before preparing/signing/broadcasting or reading a payment", async () => {
    mocks.auth.mockRejectedValue(new Error("fixture auth refusal"));
    for (const handler of [authorize, submit, cancel]) expect((await handler(req({ intentId: id, units: 4 }))).status).toBe(401);
    expect((await status(new NextRequest(`http://enki.test/api/payments/generation/status?intentId=${id}`))).status).toBe(401);
    expect(mocks.chain).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("prepares the entire batch using the session's case-exact owner, with no client amounts", async () => {
    const res = await authorize(req({ intentId: id, units: 4 }));
    expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.prepare).toHaveBeenCalledWith(mocks.db, { fixture: true }, { intentId: id, units: 4, owner: "CaseExactSessionOwner" });
  });
  it.each([0, 25, 1.5, null])("rejects invalid batch quantity %s before chain access", async units => {
    expect((await authorize(req({ intentId: id, units }))).status).toBe(400); expect(mocks.chain).not.toHaveBeenCalled();
  });
  it("rejects arbitrary recipients, owner and amount fields", async () => {
    expect((await authorize(req({ intentId: id, units: 1, owner: "stranger", totalMicro: 1 }))).status).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("returns uncertain submission as pending rather than pretending the payment is funded", async () => {
    const signedTransaction = "A".repeat(80); const res = await submit(req({ intentId: id, signedTransaction }));
    expect(await res.json()).toMatchObject({ state: "submitted", funded: false });
    expect(mocks.submit).toHaveBeenCalledWith(mocks.db, { fixture: true }, { intentId: id, signedTransaction, owner: "CaseExactSessionOwner" });
  });
  it("keeps generic errors and credentials out of the UI", async () => {
    mocks.submit.mockRejectedValue(new Error("https://rpc.invalid/private-secret?token=secret"));
    const res = await submit(req({ intentId: id, signedTransaction: "A".repeat(80) }));
    expect(res.status).toBe(503); expect(JSON.stringify(await res.json())).not.toMatch(/private-secret|token=|rpc.invalid/);
  });
  it("preserves plain service refusals", async () => {
    mocks.prepare.mockRejectedValue(new EscrowPaymentError(409, "Check your existing payment before continuing."));
    const res = await authorize(req({ intentId: id, units: 1 })); expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Check your existing payment before continuing." });
  });
  it("checks status under session ownership and never marks a pending deposit funded", async () => {
    const res = await status(new NextRequest(`http://enki.test/api/payments/generation/status?intentId=${id}`));
    expect(await res.json()).toMatchObject({ funded: false });
    expect(mocks.status).toHaveBeenCalledWith(mocks.db, { fixture: true }, id, "CaseExactSessionOwner");
  });
  it("cancels unstarted units and truthfully reports an outstanding refund", async () => {
    const res = await cancel(req({ intentId: id })); expect(await res.json()).toMatchObject({ cancelled: true, refundPending: true, state: "closing" });
    expect(mocks.advance).toHaveBeenCalledWith(mocks.db, { fixture: true }, id, "CaseExactSessionOwner", true);
  });
});
