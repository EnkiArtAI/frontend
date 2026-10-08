import { describe, it, expect, vi } from "vitest";
// Banned or deleted owners are hidden-owners.test.ts's subject; here nobody is.
vi.mock("@/lib/hidden-owners", () => ({ hiddenOwners: async () => new Set<string>() }));
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeQuote } from "@/lib/payments/generation-quote";
import { getModelCostMicro, PRICING_POLICY } from "@/lib/payments/generation-pricing";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The prompt check before every paid generation costs an OpenAI call; the
 * buyer pays it as part of the model cost (Kev, 2026-10-02). So does the
 * image check of the result and of each reference image, a free prompt's
 * render included: free only means no artist fee (Kev, 2026-10-08).
 */

describe("the buyer pays the check", () => {
  function db(prompt: Record<string, unknown> | null) {
    const from = (table: string) => {
      const q: Record<string, unknown> = {
        maybeSingle: async () => ({ data: table === "prompts" ? prompt : null, error: null }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: table === "user_wallets" ? [{ address: "ArtistWa11et1111111111111111111111111111111" }] : [], error: null }).then(ok),
      };
      for (const m of ["select", "eq", "is", "limit", "order", "lte", "gte", "or"]) q[m] = () => q;
      return q;
    };
    return { from } as unknown as SupabaseClient;
  }
  const base = getModelCostMicro("nano-banana-pro", "2K", {});

  it("on an artist's prompt, as part of the model cost", async () => {
    const q = await computeQuote(db({ price_usd_cents: 150, creator_id: "c1", prompt_type: "paid", is_free_showcase: false, is_listed: true, listing_status: "active", deleted_at: null }), { promptId: "p1", modelFamily: "nano-banana-pro", resolution: "2K" });
    if (!q.ok) throw new Error(q.error);
    expect(q.split.modelCostMicro).toBe(base + PRICING_POLICY.extractionCheckMicro + PRICING_POLICY.imageCheckMicro);
  });

  it("on the buyer's own prompt too, which is checked as well", async () => {
    const q = await computeQuote(db(null), { modelFamily: "nano-banana-pro", resolution: "2K" });
    if (!q.ok) throw new Error(q.error);
    expect(q.split.modelCostMicro).toBe(base + PRICING_POLICY.extractionCheckMicro + PRICING_POLICY.imageCheckMicro);
  });

  it("on a free prompt's render: no artist fee, the checks all the same", async () => {
    const q = await computeQuote(db({ price_usd_cents: 0, creator_id: "c1", prompt_type: "free", is_free_showcase: false, is_listed: true, listing_status: "active", deleted_at: null }), { promptId: "p1", modelFamily: "nano-banana-pro", resolution: "2K" });
    if (!q.ok) throw new Error(q.error);
    expect(q.split.artistAmountMicro).toBe(0);
    expect(q.split.modelCostMicro).toBe(base + PRICING_POLICY.extractionCheckMicro + PRICING_POLICY.imageCheckMicro);
  });

  it("once more for every reference image sent along", async () => {
    const q = await computeQuote(db(null), { modelFamily: "nano-banana-pro", resolution: "2K", referenceImageCount: 3 });
    if (!q.ok) throw new Error(q.error);
    expect(q.split.modelCostMicro).toBe(base + PRICING_POLICY.extractionCheckMicro + 4 * PRICING_POLICY.imageCheckMicro);
  });

  it("costs $0.0002 an image: the calibrated $0.00016 rounded up", () => {
    expect(PRICING_POLICY.imageCheckMicro).toBe(200);
  });
});

describe("both human rails price the reference images the buyer sends", () => {
  it.each(["quote", "intent"])("the %s route hands their count to the quote", (step) => {
    const src = readSource(join(__dirname, "..", "..", "..", "app", "api", "payments", "generation", step, "route.ts"));
    expect(src).toContain("referenceImageCount: settings.referenceImageCount,");
  });
});
