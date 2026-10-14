import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A click on a history image loads what it was made with (Kev, 2026-10-13:
 * "die exakten Settings davon links eingespielt"): GET /api/generations
 * carries each render's settings from its generation row, and the Image
 * View puts them into the composer.
 */
const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

describe("a history image's settings", () => {
  it("come from the generation row, read once per page, and null for an upload", () => {
    const route = src("app", "api", "generations", "route.ts");
    expect(route).toContain('.select("id, prompt_id, generation_id, storage_url, preview_url, thumbnail_url, description, is_uploaded, visibility, created_at", { count: \'exact\' })');
    expect(route).toContain('.select("id, model_id, aspect_ratio, resolution, boost")');
    expect(route).toContain("return s ? { modelId: s.model_id ?? null, aspectRatio: s.aspect_ratio ?? null, resolution: s.resolution ?? null, boost: s.boost === true } : null;");
    expect(route).toContain("settings: settingsOf(row.generation_id),");
  });

  it("load into the composer when the image is picked: its generator by catalogue id, ratio, size and boost", () => {
    const model = src("components", "image-view", "useImageViewModel.ts");
    expect(model).toMatch(/else if \(recorded\) \{\n\s*const own = recorded\.modelId \? catalogue\.find\(\(m\) => m\.id === recorded\.modelId\) : undefined;\n\s*if \(own\) setPick\(own\.name\);\n\s*setRatio\(recorded\.aspectRatio \?\? ""\);\n\s*setResolution\(recorded\.resolution \?\? ""\);\n\s*setBoost\(recorded\.boost\);/);
  });
});
