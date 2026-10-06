import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeQuote } from "@/lib/payments/generation-quote";
import { getModelCostMicro, PRICING_POLICY } from "@/lib/payments/generation-pricing";

/**
 * The prompt check before every paid generation costs an OpenAI call; the
 * buyer pays it as part of the model cost (Kev, 2026-10-02).
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
    expect(q.split.modelCostMicro).toBe(base + PRICING_POLICY.extractionCheckMicro);
  });

  it("on the buyer's own prompt too, which is checked as well", async () => {
    const q = await computeQuote(db(null), { modelFamily: "nano-banana-pro", resolution: "2K" });
    if (!q.ok) throw new Error(q.error);
    expect(q.split.modelCostMicro).toBe(base + PRICING_POLICY.extractionCheckMicro);
  });
});
