import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The paid render and the image check (Kev, 2026-10-08): every reference
 * image is judged before anything is charged, the result after storage and
 * before the capture. Refused or not judged: not delivered, not charged, the
 * stored copy taken down; a child-safety verdict becomes a case a human
 * decides; 18+ is delivered and marked.
 */

const HUMAN = readSource(join(__dirname, "..", "..", "app", "api", "generate-image", "route.ts"));
const at = (s: string) => {
  const i = HUMAN.indexOf(s);
  expect(i, s).toBeGreaterThan(-1);
  return i;
};

describe("the reference images", () => {
  it("are judged beside the prompt, before the slot, the claim and the provider", () => {
    const judged = at("Promise.all(refBytes.map((b) => checkImageBytes(b, { signal: request.signal }))),");
    expect(judged).toBeLessThan(at("const slot = await acquireSlot("));
    expect(judged).toBeLessThan(at("claimForGeneration("));
    expect(at("if (refsSeen.some(heldBack)) {")).toBeLessThan(at("const slot = await acquireSlot("));
  });

  it("are judged, like the prompt, only after login, the rate limits and the paid count", () => {
    const judged = at("Promise.all(refBytes.map((b) => checkImageBytes(b, { signal: request.signal }))),");
    const prompt = at("first ? NOT_CHECKED : checkPrompt(checked, { hidden: fromArtist, signal: request.signal }),");
    for (const gate of [
      'const ipLimit = checkRequestRateLimit(rateLimitKey(request, "generate:intent:ip"), 120, 60_000);',
      'if (!request.headers.get("X-Session-Token")) {',
      "authUser = await requireAuth(request);",
      'if (!checkRateLimit(authUser.userId, "generate:intent", 60, 60_000)) {',
      "if (mismatch) {",
      "if (attachedRefs > paidModel.maxRefs) {",
    ]) {
      expect(at(gate), gate).toBeLessThan(judged);
      expect(at(gate), gate).toBeLessThan(prompt);
    }
  });

  it("are read as the providers read them: a data: URL or bare base64", () => {
    at('const refBytes = refs.map((r) => dataUrlBytes(r) ?? Buffer.from(r.trim(), "base64"));');
  });

  it("stop the request when one is refused or cannot be judged, and a child-safety one becomes a case", () => {
    expect(HUMAN).toMatch(/if \(v\.verdict === "child_safety"\) \{\n\s+after\(recordImageCase\(getSupabaseServerClient\(\), \{\n\s+surface: "generate-image", request, bytes: refBytes\[i\], scores: v\.scores,/);
    at("? NextResponse.json({ error: REFERENCE_REFUSED }, { status: 422 })");
    at(": NextResponse.json({ error: REFERENCE_UNCHECKED }, { status: 503 });");
  });

  it("are stored only as judged: a graph image that never reached the model stays an empty slot", () => {
    at('stripped.images.length ? stripped.images.map((img) => (refs.includes(img) ? img : "")) : refs,');
  });
});

describe("the result", () => {
  it("is judged after storage and before the money moves, within the store deadline", () => {
    const stored = at("if (!imageUrl || Date.now() > storeDeadline(startedAt)) {");
    const judged = at("const seen = await checkImageBytes(generatedImageBuffer, {");
    expect(judged).toBeGreaterThan(stored);
    expect(judged).toBeLessThan(at("const captured = await captureAndBroadcast(settled.supabase, settled.id);"));
    at("signal: AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, storeDeadline(startedAt) - Date.now()))]),");
  });

  it("refused or not judged: no capture, no delivery, the stored copy taken down from both stores", () => {
    const refused = at("if (heldBack(seen)) {");
    const returned = HUMAN.indexOf(": NextResponse.json({ error: IMAGE_REFUSED }, { status: 422 });", refused);
    expect(returned).toBeGreaterThan(refused);
    const block = HUMAN.slice(refused, returned);
    expect(block).toContain("after(removeStored([imageUrl, storedName]));");
    expect(block).toContain('await releaseIfConsumed(seen.verdict === "unavailable" ? "provider_failed" : "rejected");');
    expect(block).toContain("await releaseHeldSlot();");
    expect(block).not.toContain("captureAndBroadcast");
    expect(block).toContain('? NextResponse.json({ error: IMAGE_UNCHECKED }, { status: 503 })');
  });

  it("a child-safety result becomes a case with the bytes in hand, never a warning or a ban", () => {
    expect(HUMAN).toMatch(/if \(seen\.verdict === "child_safety"\) \{\n\s+after\(recordImageCase\(getSupabaseServerClient\(\), \{\n\s+surface: "generate-image", request, bytes: generatedImageBuffer, scores: seen\.scores,/);
  });

  it("is stored under one name the removal knows", () => {
    expect(HUMAN).toMatch(/const storedName = `generations\/\$\{Date\.now\(\)\}_\$\{Math\.random\(\)\.toString\(36\)\.substring\(2, 9\)\}\.png`;\n\s+const imageUrl =\n\s+\(await putDurably\(\n\s+storedName,/);
  });
});

describe("the refusals say nothing was charged, and never accuse", () => {
  it("one sentence for explicit and child safety alike", async () => {
    const m = await import("@/lib/moderation/image-check-bytes");
    expect(m.IMAGE_REFUSED).toBe("This image can't be delivered on Enki. Nothing was charged.");
    expect(m.REFERENCE_REFUSED).toBe("One of your reference images can't be used on Enki. Nothing was generated and nothing was charged.");
    for (const s of [m.IMAGE_REFUSED, m.IMAGE_UNCHECKED, m.REFERENCE_REFUSED, m.REFERENCE_UNCHECKED]) expect(s).not.toMatch(/child|minor|sexual|explicit|abuse/i);
    expect(m.heldBack({ verdict: "blocked" }) && m.heldBack({ verdict: "child_safety" }) && m.heldBack({ verdict: "unavailable" })).toBe(true);
    expect(m.heldBack({ verdict: "clear" }) || m.heldBack({ verdict: "adult" })).toBe(false);
  });
});
