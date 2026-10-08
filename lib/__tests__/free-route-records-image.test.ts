import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * ENG-07. A free render called recordGeneration without imageUrl, and the
 * recorder writes the generated_images row only when one is given: every
 * free image was missing from its owner's gallery. The route now stores the
 * image (retries, fallback bucket) before it answers and records our copy,
 * never a data URL. The answer carries the same URL, so the client's copy and
 * the gallery row match (a data URL showed every free image twice).
 */

const ROUTE = readSource(join(__dirname, "..", "..", "app", "api", "generate-free", "route.ts"));
const block = ROUTE.slice(ROUTE.indexOf("after(async () => {"), ROUTE.indexOf("return NextResponse.json({\n      imageUrl: delivered,"));
const before = ROUTE.slice(ROUTE.indexOf("let delivered = imageUrl;"), ROUTE.indexOf("after(async () => {"));

describe("a free render reaches its owner's gallery", () => {
  it("is stored before the answer, which carries our copy's URL", () => {
    expect(before).toMatch(/const quick = await storeGeneratedImage\(imageUrl, recUserId, Math\.min\(Date\.now\(\) \+ 30_000, storeDeadline\(startedAt\)\)\);\n\s+delivered = quick\.imageUrl;/);
    expect(ROUTE).toContain("return NextResponse.json({\n      imageUrl: delivered,");
  });

  it("is stored again after the response when the first store missed", () => {
    expect(block).toMatch(/const stored = quick\.imageUrl\.startsWith\("data:"\)\n\s+\? await storeGeneratedImage\(imageUrl, recUserId, Math\.min\(Date\.now\(\) \+ 120_000, storeDeadline\(startedAt\)\)\)\n\s+: quick;/);
    // The clock starts with the request, not with the response.
    expect(ROUTE).toMatch(/export async function POST\(request: NextRequest\) \{\n(\s*\/\/.*\n)*\s+const startedAt = Date\.now\(\);/);
  });

  it("records our copy and never a data URL", () => {
    expect(block).toMatch(/await recordGeneration\(supabase, \{\n\s+adult: adult \|\| seen\.verdict === "adult",\n\s+\.\.\.\(stored\.imageUrl\.startsWith\("data:"\) \? \{\} : stored\),/);
    expect(block.indexOf("const stored =")).toBeLessThan(block.indexOf("await recordGeneration("));
  });

  it("stores no reference image: the free model takes none, so none is ever judged", () => {
    expect(block).toContain("references: [],");
    expect(ROUTE).not.toContain("storeReferenceImages(");
  });
});
