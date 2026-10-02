import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSource } from "@/lib/__tests__/_read-source";
import { settingsSchema, resolvePaidSettings, settingMismatch } from "@/lib/payments/generation-settings";

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

  const routeSrc = (route: string) =>
    readSource(join(__dirname, "..", "..", "..", "app", "api", "payments", "generation", route, "route.ts"));

  it("the intent route parses with it and resolves before pricing", () => {
    const src = routeSrc("intent");
    const parse = src.indexOf("settingsSchema.safeParse(body)");
    const resolve = src.indexOf("resolvePaidSettings(supabase, parsed.data)");
    const price = src.indexOf("computeQuote(supabase, {");
    expect(parse).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(parse);
    expect(price).toBeGreaterThan(resolve);
    expect(src).toMatch(/modelFamily: settings\.modelFamily,/);
  });

  it("the quote route prices every request, single or batch, through the same resolve-then-price step", () => {
    const src = routeSrc("quote");
    const resolve = src.indexOf("resolvePaidSettings(supabase, input)");
    const price = src.indexOf("computeQuote(supabase, {");
    expect(resolve).toBeGreaterThan(-1);
    expect(price).toBeGreaterThan(resolve);
    expect(src).toMatch(/const batchSchema = z\.object\(\{ items: z\.array\(settingsSchema\)\.min\(1\)\.max\(24\) \}\);/);
    expect(src).toMatch(/batch\.data\.items\.map\(\(item\) => quoteOne\(supabase, item, authUser\)\)/);
    expect(src).toMatch(/const one = await quoteOne\(supabase, parsed\.data, authUser\);/);
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

describe("settingMismatch", () => {
  const PAID = { model_id: GPT.id, resolution: "2K", quality: "low", boost: false, reference_image_count: 2 };
  const asked = (over: Record<string, unknown> = {}) => ({ resolution: null, referenceImageCount: 2, ...over });

  it("accepts a request that repeats nothing or repeats exactly what was paid", () => {
    expect(settingMismatch(PAID, asked(), true)).toBeNull();
    expect(settingMismatch(PAID, asked({ modelIds: [GPT.id], resolution: "2K", quality: "low", boost: false }), true)).toBeNull();
  });

  it("refuses the cheap-quality, dear-render trade", () => {
    expect(settingMismatch(PAID, asked({ quality: "high" }), true)).toBe("quality");
  });

  it("ignores quality on a model without the lever", () => {
    expect(settingMismatch({ ...PAID, model_id: NANO.id, quality: null }, asked({ quality: "high" }), false)).toBeNull();
  });

  it("refuses another model row, even one of the same family, and a list of several", () => {
    expect(settingMismatch(PAID, asked({ modelIds: [NANO.id] }), true)).toBe("model");
    expect(settingMismatch(PAID, asked({ modelIds: [GPT.id, NANO.id] }), true)).toBe("model");
    expect(settingMismatch(PAID, asked({ modelIds: GPT.id }), true)).toBeNull();
  });

  it("refuses another resolution, boost or reference count", () => {
    expect(settingMismatch(PAID, asked({ resolution: "4K" }), true)).toBe("resolution");
    expect(settingMismatch(PAID, asked({ boost: true }), true)).toBe("boost");
    expect(settingMismatch(PAID, asked({ boost: "false" }), true)).toBe("boost");
    // Strictly the boolean paid for: a truthy stand-in is another request.
    expect(settingMismatch({ ...PAID, boost: true }, asked({ boost: 1 }), true)).toBe("boost");
    expect(settingMismatch(PAID, asked({ referenceImageCount: 3 }), true)).toBe("number of reference images");
    expect(settingMismatch(PAID, asked({ referenceImageCount: 0 }), true)).toBe("number of reference images");
  });
});

describe("/api/generate-image runs the paid settings", () => {
  const ROUTE = readSource(join(__dirname, "..", "..", "..", "app", "api", "generate-image", "route.ts"));

  it("routes and renders with the intent's boost, tier and quality, never the body's", () => {
    expect(ROUTE).toMatch(/boost: paid\.boost,\n\s+quality: effQuality,\n\s+resolution: preflightModel\.supportsResolution \? paidTier : null,/);
    expect(ROUTE).toMatch(/\? effectiveQuality\(paidTier, paid\.quality\)/);
    // The body's own values appear only where they are compared with the payment.
    expect(ROUTE.match(/body\.(boost|quality)\b/g)).toEqual(["body.quality", "body.boost"]);
  });

  it("has no free host on the paid route and drops no reference", () => {
    expect(ROUTE).toMatch(/const IMPLEMENTED: readonly string\[\] = \["gemini", "wavespeed", "openai"\];/);
    expect(ROUTE).not.toMatch(/pollinations-image-generation/);
    expect(ROUTE).not.toMatch(/referenceImages\?\.slice\(/);
  });
});
