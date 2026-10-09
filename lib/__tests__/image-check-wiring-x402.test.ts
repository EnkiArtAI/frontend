import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The agent rail and the image check (Kev, 2026-10-08). An agent's payment
 * expires with its blockhash, about a minute, before a slow render ends, so
 * it settles first, as before, and the check judges the stored render after.
 * What it refuses or cannot judge is withheld, its copies taken down, and
 * recorded with the signature for support.
 */

const AGENT = readSource(join(__dirname, "..", "..", "app", "api", "x402", "generate", "route.ts"));
const at = (s: string, from = 0) => {
  const i = AGENT.indexOf(s, from);
  expect(i, s).toBeGreaterThan(-1);
  return i;
};
/** From the check's refusal to the delivery that follows it. */
const heldBlock = () => AGENT.slice(at("if (heldBack(seen)) {"), at("imageUrl: stored.imageUrl,"));

describe("the agent rail", () => {
  it("settles, renders, stores, and checks before it delivers", () => {
    const settle = at("const settled = await submitAndConfirm(solanaConnection(), parsed.tx);");
    const render = at('route.provider === "wavespeed" ? await generateImagesWithWaveSpeed(genRequest)');
    // REC-3: the storage namespace is the verified payer's own wallet now,
    // never the pseudo-user "x402-agent".
    const store = at('await storeGeneratedImage(dataUrl, payerWallet, storeDeadline(startedAt))');
    const check = at("const seen = await checkImageBytes(buffer, { signal: AbortSignal.timeout(Math.max(1, storeDeadline(startedAt) - Date.now())) });");
    const deliver = at("imageUrl: stored.imageUrl,");
    expect([settle, render, store, check, deliver]).toEqual([settle, render, store, check, deliver].slice().sort((a, b) => a - b));
    expect(AGENT).not.toContain("isBlockhashValid");
  });

  it("held back by the check: recorded with the signature, a case by address on child safety, the copies taken down, never delivered", () => {
    const block = heldBlock();
    expect(block).toMatch(/error: `image check: \$\{seen\.verdict\}`, txSignature: signature,/);
    expect(block).toMatch(/if \(seen\.verdict === "child_safety"\) \{\n\s+after\(recordImageCase\(supabase, \{\n\s+surface: "x402-generate", request, bytes: buffer, scores: seen\.scores, byAddress: true,/);
    expect(block).toContain("after(removeStored(stored.names));");
    // The refusal returns before the delivery's own answer begins. Since
    // REC-3, the shared-pipeline recording (after(), fire-and-forget — it
    // cannot delay or gate either return) sits between the two; tolerated
    // here as "any content", not matched specifically, because this test's
    // job is the heldBack branch's own early return, not that block's shape.
    expect(block).toMatch(/\}\n\n[\s\S]*\n\n\s+return NextResponse\.json\(\n\s+\{\n\s+$/);
  });

  it("an image it could not store is never left public unjudged: every copy a cut upload may land comes down", () => {
    const unstored = at("if (stored.imageUrl === dataUrl && buffer.length > INLINE_MAX_BYTES) {");
    expect(AGENT.slice(unstored, at("const seen = await checkImageBytes(buffer,"))).toContain("after(removeStored(stored.names));");
  });

  it("tells the agent its payment settled and keeps the signature for support", () => {
    const block = heldBlock();
    expect(block).toContain('? "Your image could not be checked right now, so it was not delivered after your payment settled."');
    expect(block).toContain(': "This image can\'t be delivered on Enki. Your payment settled.",');
    expect(block).toContain('note: "Keep this transaction signature — support will make it right.",');
    expect(block).toContain('status: seen.verdict === "unavailable" ? 502 : 422,');
    // Paid: the settlement header goes with it, as on a delivery.
    expect(block).toContain('headers: { "X-PAYMENT-RESPONSE": paymentResponseHeader(signature, "solana", feePayer.publicKey) },');
    expect(block).not.toMatch(/\b503\b/);
    expect(block).not.toMatch(/Nothing was charged|child[^_]|minor|sexual|explicit|abuse/i);
  });
});
