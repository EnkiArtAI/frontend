import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSource } from "@/lib/__tests__/_read-source";
import { settingsSchema, resolvePaidSettings } from "@/lib/payments/generation-settings";

/**
 * The quote and the intent take the sum of settings, and the server decides
 * what they mean before anything is priced. Rows mirror the live catalogue
 * (read 2026-10-02): Flux on Pollinations, Nano Banana Pro on WaveSpeed with a
 * Gemini boost, GPT-Image-2 on OpenAI/WaveSpeed with its boost link inactive.
 */

const link = (role: string, key: string, model: string, extra: Record<string, unknown> = {}) => ({
  id: `${key}-${role}`, role, provider_model: model, active: true, priority: 10, applies_when: null,
  provider_id: key, providers: { id: key, key, audience: "public", active: true }, ...extra,
});

const FLUX = { id: "fee61592-88fc-4235-b060-2fc76b49bf89", name: "Flux (free)", allowed_ratios: ["1:1"], max_reference_images: 0,
  model_providers: [link("normal", "pollinations", "flux")] };
const NANO = { id: "db00c518-ee31-4d12-b40a-f8130f8e605b", name: "Nano Banana Pro", allowed_ratios: ["1:1"], max_reference_images: 14,
  model_providers: [link("normal", "wavespeed", "google/nano-banana-pro/text-to-image"), link("boost", "gemini", "gemini-3-pro-image")] };
const GPT = { id: "14b3db65-08e3-49a5-b8bb-57f6d5821099", name: "GPT-Image-2", allowed_ratios: ["1:1"], max_reference_images: 16,
  model_providers: [link("normal", "openai", "gpt-image-2"), { ...link("boost", "openai", "gpt-image-2"), active: false }] };

/** resolveModel's chain: from("models").select().in("id", ids).eq("active", true), awaited. */
function catalogue(rows: Array<{ id: string }>) {
  let ids: string[] = [];
  const chain = {
    select: () => chain,
    in: (_c: string, v: string[]) => { ids = v; return chain; },
    eq: () => Promise.resolve({ data: rows.filter((r) => ids.includes(r.id)), error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}
/** A host this repo does not know renders 1K at most (maxTier fails closed). */
const SMALL = { id: "5a11a11a-0000-4000-8000-000000000001", name: "Small Host Model", allowed_ratios: ["1:1"], max_reference_images: 0,
  model_providers: [link("normal", "openai", "dall-e-3")] };
const DB = catalogue([FLUX, NANO, GPT, SMALL]);

describe("resolvePaidSettings", () => {
  it("names the exact row and its family", async () => {
    const r = await resolvePaidSettings(DB, { modelId: NANO.id, resolution: "4K" });
    expect(r).toEqual({
      ok: true,
      settings: { modelId: NANO.id, modelFamily: "nano-banana-pro", resolution: "4K", quality: null, boost: false, referenceImageCount: 0 },
    });
  });

  it("stores the quality that will run, so a 4K gpt request without one is priced and run at high", async () => {
    const r = await resolvePaidSettings(DB, { modelId: GPT.id, resolution: "4K" });
    expect(r.ok && r.settings.quality).toBe("high");
    const low = await resolvePaidSettings(DB, { modelId: GPT.id, resolution: "4K", quality: "low" });
    expect(low.ok && low.settings.quality).toBe("low");
  });

  it("drops a quality the model does not take", async () => {
    const r = await resolvePaidSettings(DB, { modelId: NANO.id, resolution: "2K", quality: "high" });
    expect(r.ok && r.settings.quality).toBeNull();
  });

  it("keeps boost only where a faster host exists, and refuses it elsewhere", async () => {
    const nano = await resolvePaidSettings(DB, { modelId: NANO.id, resolution: "2K", boost: true });
    expect(nano.ok && nano.settings.boost).toBe(true);
    expect(await resolvePaidSettings(DB, { modelId: GPT.id, resolution: "2K", boost: true })).toMatchObject({ ok: false, status: 422 });
  });

  it("refuses a resolution above what the model renders", async () => {
    expect(await resolvePaidSettings(DB, { modelId: SMALL.id, resolution: "2K" })).toMatchObject({ ok: false, error: expect.stringMatching(/up to 1K/) });
    expect(await resolvePaidSettings(DB, { modelId: SMALL.id, resolution: "1K" })).toMatchObject({ ok: true });
  });

  it("refuses an unknown model, the free model, and more references than the model takes", async () => {
    expect(await resolvePaidSettings(DB, { modelId: "00000000-0000-4000-8000-000000000000", resolution: "2K" })).toMatchObject({ ok: false });
    expect(await resolvePaidSettings(DB, { modelId: FLUX.id, resolution: "2K" })).toMatchObject({ ok: false, error: expect.stringMatching(/free/) });
    expect(await resolvePaidSettings(DB, { modelId: NANO.id, resolution: "2K", referenceImageCount: 15 })).toMatchObject({ ok: false });
    const fourteen = await resolvePaidSettings(DB, { modelId: NANO.id, resolution: "2K", referenceImageCount: 14 });
    expect(fourteen.ok && fourteen.settings.referenceImageCount).toBe(14);
  });
});

describe("settingsSchema", () => {
  it("takes an own-prompt request and requires the model row and the resolution", () => {
    expect(settingsSchema.safeParse({ modelId: NANO.id, resolution: "2K" }).success).toBe(true);
    expect(settingsSchema.safeParse({ modelId: NANO.id }).success).toBe(false);
    expect(settingsSchema.safeParse({ modelFamily: "nano-banana-pro", resolution: "2K" }).success).toBe(false);
  });

  it.each(["intent", "quote"])("the %s route parses with it and resolves before pricing", (route) => {
    const src = readSource(join(__dirname, "..", "..", "..", "app", "api", "payments", "generation", route, "route.ts"));
    const parse = src.indexOf("settingsSchema.safeParse(body)");
    const resolve = src.indexOf("resolvePaidSettings(supabase, parsed.data)");
    const price = src.indexOf("computeQuote(supabase, {");
    expect(parse).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(parse);
    expect(price).toBeGreaterThan(resolve);
    expect(src).toMatch(/modelFamily: settings\.modelFamily,/);
  });

  it("the intent stores every setting it priced", () => {
    const route = readSource(join(__dirname, "..", "..", "..", "app", "api", "payments", "generation", "intent", "route.ts"));
    // The insert alone: the same names also appear in the computeQuote call above it.
    const start = route.indexOf(".insert({");
    expect(start).toBeGreaterThan(-1);
    const src = route.slice(start, route.indexOf("})", start));
    for (const col of ["model_id: settings.modelId", "resolution: settings.resolution", "quality: settings.quality", "boost: settings.boost", "reference_image_count: settings.referenceImageCount"]) {
      expect(src).toContain(col);
    }
  });
});
