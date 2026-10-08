import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The free model route and the image check (Kev, 2026-10-08): the image is
 * judged before anything is stored or shown; refused or not judged, no copy
 * of it exists, the allowance comes back, and a child-safety verdict becomes
 * a case. Enki carries the check here: nothing is paid.
 */

const FREE = readSource(join(__dirname, "..", "..", "app", "api", "generate-free", "route.ts"));
const at = (s: string) => {
  const i = FREE.indexOf(s);
  expect(i, s).toBeGreaterThan(-1);
  return i;
};

describe("a free render", () => {
  it("is judged from its bytes before the first store", () => {
    const judged = at("const seen = await checkImageBytes(buffer, {");
    expect(judged).toBeLessThan(at("const quick = await storeGeneratedImage("));
    expect(judged).toBeLessThan(at("return NextResponse.json({\n      imageUrl: delivered,"));
    // A closed tab never cancels it: the render is kept.
    const call = FREE.slice(judged, FREE.indexOf("});", judged));
    expect(call).toContain("signal: AbortSignal.timeout(Math.max(1, storeDeadline(startedAt) - 30_000 - Date.now())),");
    expect(call).not.toContain("request.signal");
  });

  it("held back: recorded as a failure, a case when it is child safety, the claim given back, never delivered", () => {
    const held = at("if (heldBack(seen)) {");
    const block = FREE.slice(held, FREE.indexOf("const quick = await storeGeneratedImage("));
    expect(block).toContain("after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: `image check: ${seen.verdict}` }));");
    expect(block).toMatch(/if \(seen\.verdict === "child_safety"\) \{\n\s+after\(recordImageCase\(supabaseForChecks, \{ surface: "generate-free", request, bytes: buffer, scores: seen\.scores,/);
    expect(block).toContain("await releaseFreeClaim(supabaseForChecks, claimId);");
    expect(block).toContain('? NextResponse.json({ error: IMAGE_UNCHECKED }, { status: 503 })');
    expect(block).toContain(': NextResponse.json({ error: IMAGE_REFUSED }, { status: 422 });');
    expect(block).not.toContain("delivered");
  });
});
