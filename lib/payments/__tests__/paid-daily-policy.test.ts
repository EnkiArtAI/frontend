import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
const mock = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/lib/payments/pricing-rules", async importOriginal => ({
  ...await importOriginal<typeof import("../pricing-rules")>(), resolvePricingRule: mock.resolve,
}));
import { computeQuote } from "../generation-quote";
const db = {} as SupabaseClient;
beforeEach(() => vi.clearAllMocks());
describe("one free baseline daily, paid catalogue stays paid", () => {
  it("keeps a premium model paid even when the database still returns a historical free rule", async () => {
    mock.resolve.mockResolvedValue({ id: "legacy-free", name: "old campaign", effect: { type: "free_generation", uses_per_day: 3 } });
    const result = await computeQuote(db, { modelFamily: "gpt-image-2", resolution: "1K", buyer: "fixture-buyer" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedRule).toBeNull(); expect(result.split.totalMicro).toBeGreaterThan(0); expect(result.split.modelCostMicro).toBeGreaterThan(0);
    expect(mock.resolve).toHaveBeenCalledWith(db, expect.objectContaining({ excludeFreeGeneration: true }));
  });
  it("still honors a fee discount while charging the provider's actual priced model leg", async () => {
    mock.resolve.mockResolvedValue({ id: "fee-discount", name: "fee offer", effect: { type: "fee_percent_off", value: 100 } });
    const discounted = await computeQuote(db, { modelFamily: "gpt-image-2", resolution: "1K", buyer: "fixture-buyer" });
    mock.resolve.mockResolvedValue(null);
    const regular = await computeQuote(db, { modelFamily: "gpt-image-2", resolution: "1K", buyer: "fixture-buyer" });
    expect(discounted.ok && regular.ok).toBe(true); if (!discounted.ok || !regular.ok) return;
    expect(discounted.split.modelCostMicro).toBe(regular.split.modelCostMicro);
    expect(discounted.split.totalMicro).toBeGreaterThan(0); expect(discounted.split.totalMicro).toBeLessThan(regular.split.totalMicro);
  });
});
