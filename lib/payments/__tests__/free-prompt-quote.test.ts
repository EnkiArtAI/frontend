import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeQuote } from "@/lib/payments/generation-quote";
import { computeGenerationSplit, getModelCostMicro, PRICING_POLICY } from "@/lib/payments/generation-pricing";

/**
 * A free prompt carries no artist share. The quote decided "free" by the
 * client's word "free-prompt", while the database stores "free", and a save
 * without a price stores 100 cents: a free prompt was quoted $1.00 to the
 * artist plus the fee on it, $1.10 too much per image.
 */

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
const quote = (prompt: Record<string, unknown>) =>
  computeQuote(db({ creator_id: "c1", is_free_showcase: false, is_listed: true, listing_status: "active", deleted_at: null, ...prompt }), { promptId: "p1", modelFamily: "nano-banana-pro", resolution: "2K" });
const model = getModelCostMicro("nano-banana-pro", "2K", {}) + PRICING_POLICY.extractionCheckMicro;

describe("a free prompt's quote", () => {
  it.each([
    ["a prompt stored as free, saved with the default price", { prompt_type: "free", price_usd_cents: 100 }],
    ["a showcase", { prompt_type: "showcase", price_usd_cents: 100 }],
    ["a prompt flagged as a free showcase", { prompt_type: "create-now", is_free_showcase: true, price_usd_cents: 100 }],
  ])("has no artist share: %s", async (_name, prompt) => {
    const q = await quote(prompt);
    if (!q.ok) throw new Error(q.error);
    expect(q.artistWallet).toBeNull();
    expect(q.split).toEqual(computeGenerationSplit(0, model));
  });

  it("leaves a paid prompt its artist share", async () => {
    const q = await quote({ prompt_type: "paid", price_usd_cents: 150 });
    if (!q.ok) throw new Error(q.error);
    expect(q.split.artistAmountMicro).toBe(1_500_000);
    expect(q.artistWallet).toBe("ArtistWa11et1111111111111111111111111111111");
  });
});

describe("the server never compares a stored prompt type with the client's word", () => {
  // The database holds free, paid, showcase, create-now; "free-prompt", "paid-prompt" and
  // "premium-prompt" exist only in the client and in the two mapping tables of the save and detail routes.
  const ROOT = join(__dirname, "..", "..", "..");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : files(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
  const CLIENT_WORD = /prompt_type\s*[!=]==\s*["'](free|paid|premium)-prompt["']/;

  it("in lib and in the API routes", () => {
    const sources = [...files(join(ROOT, "lib")), ...files(join(ROOT, "app", "api"))];
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.filter((f) => CLIENT_WORD.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
