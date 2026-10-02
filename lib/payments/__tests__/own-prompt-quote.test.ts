import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeQuote } from "@/lib/payments/generation-quote";
import { resolvePricingRule } from "@/lib/payments/pricing-rules";
import { computeGenerationSplit, getModelCostMicro } from "@/lib/payments/generation-pricing";

/**
 * The editors generate from the buyer's OWN prompt, so their intents name no
 * prompt: no artist, no artist leg, and no prompt-scoped discount. Before
 * this, every intent had to name a marketplace prompt, which is why the
 * editors could only pay through the legacy X-PAYMENT path.
 */

/** Any query chain resolves to the table's rows; reads are recorded. */
function fakeSupabase(tables: Record<string, unknown[]>) {
  const read: string[] = [];
  const from = (table: string) => {
    read.push(table);
    const result = { data: tables[table] ?? [], error: null };
    const chain: Record<string, unknown> = {
      maybeSingle: () => Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      then: (ok: (v: typeof result) => unknown) => Promise.resolve(result).then(ok),
    };
    for (const m of ["select", "eq", "or", "order", "ilike", "is", "limit", "gte", "in"]) chain[m] = () => chain;
    return chain;
  };
  return { client: { from } as unknown as SupabaseClient, read };
}

const BUYER = "11111111-1111-4111-8111-111111111111";

describe("an intent for the buyer's own prompt", () => {
  it("prices the model leg only and never looks up a prompt or an artist", async () => {
    const { client, read } = fakeSupabase({});
    const q = await computeQuote(client, { modelFamily: "gpt-image-2", resolution: "2K" });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.artistWallet).toBeNull();
    expect(q.split).toEqual(computeGenerationSplit(0, getModelCostMicro("gpt-image-2", "2K")));
    expect(read).not.toContain("prompts");
    expect(read).not.toContain("user_wallets");
  });

  it("still refuses a named prompt that does not exist", async () => {
    const { client } = fakeSupabase({ prompts: [] });
    const q = await computeQuote(client, { promptId: "p-404", modelFamily: "gpt-image-2" });
    expect(q).toMatchObject({ ok: false, status: 404 });
  });

  it("gets no discount scoped to marketplace prompts", async () => {
    const rule = { id: "r1", name: "promo", priority: 1, audience: {}, scope: { prompt_ids: ["p-1"] }, effect: { type: "fee_percent_off", value: 50 } };
    const { client } = fakeSupabase({ pricing_rules: [rule], users: [{ role: "user" }] });
    expect(await resolvePricingRule(client, { buyerWalletOrId: BUYER, modelFamily: "gpt-image-2" })).toBeNull();
    // The same rule does apply to the prompt it names, so the null above is the scope.
    expect(await resolvePricingRule(client, { buyerWalletOrId: BUYER, modelFamily: "gpt-image-2", promptId: "p-1" })).toMatchObject({ id: "r1" });
  });
});

describe("both payment routes accept an intent without a prompt", () => {
  it.each(["intent", "quote"])("%s schema makes promptId optional", (route) => {
    const src = readSource(join(__dirname, "..", "..", "..", "app", "api", "payments", "generation", route, "route.ts"));
    expect(src).toMatch(/promptId: z\.string\(\)\.min\(1\)\.max\(128\)\.optional\(\),/);
  });
});
