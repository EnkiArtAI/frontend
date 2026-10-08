import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The agent rail and the image check (Kev, 2026-10-08): the payment settles
 * only after the image is made, stored and checked. There is no refund rail,
 * so this order is the only way "refused or not judged: not delivered, not
 * charged" holds. The replay guard stays before the work, so one payment
 * buys one render even in parallel.
 */

const AGENT = readSource(join(__dirname, "..", "..", "app", "api", "x402", "generate", "route.ts"));
const at = (s: string, from = 0) => {
  const i = AGENT.indexOf(s, from);
  expect(i, s).toBeGreaterThan(-1);
  return i;
};

describe("the agent rail", () => {
  it("guards the replay, then renders, stores, checks, and only then settles", () => {
    const replay = at('checkAndRecordSolanaSignature(signature, chainKey, "x402-agent-generate")');
    const fresh = at("const fresh = await solanaConnection().isBlockhashValid(parsed.tx.message.recentBlockhash)");
    const render = at("route.provider === \"wavespeed\" ? await generateImagesWithWaveSpeed(genRequest)");
    const store = at('await storeGeneratedImage(dataUrl, "x402-agent", storeDeadline(startedAt))');
    const check = at("const seen = await checkImageBytes(buffer, { signal: AbortSignal.timeout(Math.max(1, storeDeadline(startedAt) - Date.now())) });");
    const settle = at("const settled = await submitAndConfirm(solanaConnection(), parsed.tx, Math.max(1_000, startedAt + 295_000 - Date.now()));");
    expect([replay, fresh, render, store, check, settle]).toEqual([replay, fresh, render, store, check, settle].slice().sort((a, b) => a - b));
    expect((AGENT.match(/submitAndConfirm\(/g) ?? []).length).toBe(1);
  });

  it("refuses an already expired payment before rendering anything", () => {
    expect(AGENT).toMatch(/if \(!fresh\) \{\n\s+return NextResponse\.json\(\{ error: "This payment transaction has expired\. Nothing was charged\. Sign a new one\.", transaction: signature \}, \{ status: 402 \}\);/);
    // An RPC hiccup is no verdict: the settlement still decides.
    at(".then((r) => r.value).catch(() => true);");
  });

  it("held back by the check: recorded, a case by address on child safety, the copies taken down, never settled", () => {
    const held = at("if (heldBack(seen)) {");
    const block = AGENT.slice(held, at("const settled = await submitAndConfirm("));
    expect(block).toMatch(/after\(recordImageCase\(supabase, \{\n\s+surface: "x402-generate", request, bytes: buffer, scores: seen\.scores, byAddress: true,/);
    expect(block).toContain("after(removeStored(copies));");
    expect(block).toContain("? NextResponse.json({ error: IMAGE_UNCHECKED, transaction: signature }, { status: 503 })");
    expect(block).toContain(": NextResponse.json({ error: IMAGE_REFUSED, transaction: signature }, { status: 422 });");
    at("const copies = [stored.imageUrl, stored.previewUrl, stored.thumbnailUrl];");
  });

  it("a payment that does not settle takes the copies down: not paid, not delivered", () => {
    const failed = at("if (!settled.ok) {");
    const block = AGENT.slice(failed, at("return NextResponse.json(", at("{ status: settled.pending ? 504 : 402 },")));
    expect(block).toContain("after(removeStored(copies));");
  });

  it("says nothing was charged wherever the work fails before the settlement", () => {
    at('"Your image was made but could not be delivered. Nothing was charged."');
    expect(AGENT).not.toMatch(/after your payment settled/);
    expect(AGENT).toContain('{ error: "This payment transaction was already used", transaction: signature },');
  });
});
