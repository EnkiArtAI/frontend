import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * ENG-07. A free render called recordGeneration without imageUrl, and the
 * recorder writes the generated_images row only when one is given: every
 * free image was missing from its owner's gallery. The route now stores the
 * image (retries, fallback bucket) and records our copy, all after the
 * response, never a data URL.
 */

const ROUTE = readSource(join(__dirname, "..", "..", "app", "api", "generate-free", "route.ts"));
const block = ROUTE.slice(ROUTE.indexOf("after(async () => {"), ROUTE.indexOf("return NextResponse.json({\n      imageUrl,"));

describe("a free render reaches its owner's gallery", () => {
  it("is stored durably, after the response", () => {
    expect(block).toMatch(/const stored = await storeGeneratedImage\(imageUrl, recUserId, Date\.now\(\) \+ 120_000\);/);
  });

  it("records our copy and never a data URL", () => {
    expect(block).toMatch(/await recordGeneration\(supabase, \{\n\s+adult,\n\s+\.\.\.\(stored\.imageUrl\.startsWith\("data:"\) \? \{\} : stored\),/);
    expect(block.indexOf("const stored =")).toBeLessThan(block.indexOf("await recordGeneration("));
  });

  it("stores references after the response too", () => {
    expect(block).toContain("references: await storeReferenceImages(stripped.images, recUserId),");
    expect(ROUTE.indexOf("storeReferenceImages(stripped")).toBeGreaterThan(ROUTE.indexOf("after(async () => {"));
  });
});
