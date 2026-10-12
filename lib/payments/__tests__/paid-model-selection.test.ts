import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { resolveModelByFamily } from "@/lib/generation/models";
import { toModelFamily } from "@/lib/generation/model-family";

/**
 * A paid request is TOLD which model it bought.
 *
 * The buyer surface sends { intentId, prompt, aspectRatio } and no modelIds —
 * it named the model when it took the quote, and model_family was written onto
 * the intent and priced from it. Resolving from body.modelIds anyway fell back
 * to DEFAULT_MODEL ("Nano Banana Pro"), so the family comparison refused every
 * GPT-Image-2 purchase and voided its authorisation.
 */

const ROOT = join(__dirname, "..", "..", "..");
const ROUTE = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));

/** Models table stub: `select().eq()` then awaited. */
function models(rows: { id: string; name: string }[], error = false) {
  const chain = {
    select: () => chain,
    eq: () => Promise.resolve({ data: error ? null : rows, error: error ? { message: "boom" } : null }) as never,
  };
  return { from: () => chain };
}

const CATALOGUE = [
  { id: "m1", name: "Nano Banana Pro" },
  { id: "m2", name: "GPT-Image-2" },
  { id: "m3", name: "Flux (free)" },
];

describe("resolveModelByFamily", () => {
  it("finds the model the payment names", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await resolveModelByFamily(models(CATALOGUE) as any, "gpt-image-2");
    expect(m?.name).toBe("GPT-Image-2");
  });

  it("matches on the slug, so a label edit is not a pricing event", async () => {
    const withSuffix = [{ id: "m2", name: "GPT-Image-2 (coming soon)" }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await resolveModelByFamily(models(withSuffix) as any, "gpt-image-2");
    expect(m?.name).toBe("GPT-Image-2 (coming soon)");
    expect(toModelFamily(m!.name)).toBe("gpt-image-2");
  });

  it("returns null rather than a default when the family names nothing", async () => {
    // A default here would silently serve a model the buyer did not pay for —
    // exactly the substitution this path exists to prevent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await resolveModelByFamily(models(CATALOGUE) as any, "midjourney")).toBeNull();
  });

  it("returns null on a failed lookup, never a guess", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await resolveModelByFamily(models([], true) as any, "gpt-image-2")).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await resolveModelByFamily(null as any, "gpt-image-2")).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await resolveModelByFamily(models(CATALOGUE) as any, "")).toBeNull();
  });

  it("does not confuse the three families it must keep apart", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = await resolveModelByFamily(models(CATALOGUE) as any, "nano-banana-pro");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = await resolveModelByFamily(models(CATALOGUE) as any, "gpt-image-2");
    expect(a?.name).not.toBe(b?.name);
  });
});

describe("the route lets the purchase choose the model", () => {
  it("reads the intent's settings BEFORE resolving the model, and the model by its row id", () => {
    const family = ROUTE.indexOf('.select("model_id, model_family, resolution, quality, boost, reference_image_count, prompt_id, artist_amount_micro")');
    const resolve = ROUTE.indexOf("resolveModel(getSupabaseServerClientSafe(), [paid.model_id])");
    const route = ROUTE.indexOf("const preflightRoute = await chooseRoute(");
    expect(family).toBeGreaterThan(-1);
    // The routing, the reference-image eligibility and the quote all hang off
    // preflightModel, so the family has to land before any of them.
    expect(resolve).toBeGreaterThan(family);
    expect(route).toBeGreaterThan(resolve);
  });

  it("refuses when the paid family is not available, instead of substituting", () => {
    expect(ROUTE).toMatch(/This paid model is unavailable right now/);
  });

  it("refuses a request that repeats a setting differently, before the slot", () => {
    // Pay for the cheap family or quality, ask for the dear one.
    const check = ROUTE.indexOf("const mismatch = settingMismatch(");
    expect(check).toBeGreaterThan(-1);
    expect(ROUTE.indexOf("const slot = await acquireSlot(")).toBeGreaterThan(check);
    // The refusal answers the check directly, nothing in between.
    expect(ROUTE).toMatch(/if \(mismatch\) \{\n\s+return NextResponse\.json\(\n\s+\{ error: "The selected settings differ from this payment/);
  });

  it("runs the model the purchase names, never the request's own pick", () => {
    expect(ROUTE).toMatch(/const preflightModel = paidModel;/);
    expect(ROUTE).not.toMatch(/preflightModel = (await )?resolveModel\(/);
  });

  it("has no unpaid branch: no intent is refused before any model or slot is touched", () => {
    // REC-4: every generation on this route holds a payment.
    const refuse = ROUTE.indexOf("if (!intentId) {");
    expect(refuse).toBeGreaterThan(-1);
    expect(ROUTE.indexOf("resolveModel(getSupabaseServerClientSafe(), [paid.model_id])")).toBeGreaterThan(refuse);
    expect(ROUTE.indexOf("const slot = await acquireSlot(")).toBeGreaterThan(refuse);
  });
});
