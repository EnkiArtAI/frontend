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
  it("reads the intent's family BEFORE resolving the model", () => {
    const family = ROUTE.indexOf("paidFamily = ");
    const resolve = ROUTE.indexOf("resolveModelByFamily(");
    const route = ROUTE.indexOf("const preflightRoute = await chooseRoute(");
    expect(family).toBeGreaterThan(-1);
    // The routing, the reference-image eligibility and the quote all hang off
    // preflightModel, so the family has to land before any of them.
    expect(resolve).toBeGreaterThan(family);
    expect(route).toBeGreaterThan(resolve);
  });

  it("refuses when the paid family is not available, instead of substituting", () => {
    expect(ROUTE).toMatch(/which is not available right now/);
  });

  it("still refuses an explicit model that disagrees with the purchase", () => {
    // Pay for the cheap family, ask for the dear one — the only fraud case
    // left once the intent selects the model.
    expect(ROUTE).toMatch(/but the request asks for/);
  });

  /** The `if (paidFamily) { … }` block, isolated from its else. */
  function paidBranch(): string {
    const start = ROUTE.indexOf("if (paidFamily) {");
    expect(start, "the paid branch moved — this test is reading the wrong block").toBeGreaterThan(-1);
    const end = ROUTE.indexOf("} else {", start);
    expect(end, "no else branch found after the paid branch").toBeGreaterThan(start);
    return ROUTE.slice(start, end);
  }

  it("the PAID branch assigns the model it resolved from the purchase", () => {
    // The first draft of this test asserted only that the default resolution
    // appeared SOMEWHERE in the route, which stayed true when the paid branch
    // was mutated back to using it — the probe passed and proved nothing.
    const branch = paidBranch();
    expect(branch).toMatch(/preflightModel = paidModel/);
    expect(branch).not.toMatch(/preflightModel = await resolveModel\(/);
  });

  it("uses the request's own selection only when nothing was paid, and refuses it when it cannot be resolved", () => {
    const start = ROUTE.indexOf("} else {", ROUTE.indexOf("if (paidFamily) {"));
    const unpaid = ROUTE.slice(start, start + 600);
    expect(unpaid).toMatch(/const chosen = await resolveModel\(getSupabaseServerClientSafe\(\), body\.modelIds\)/);
    expect(unpaid).toMatch(/if \(!chosen\) \{/);
    expect(unpaid).toMatch(/preflightModel = chosen;/);
  });
});
