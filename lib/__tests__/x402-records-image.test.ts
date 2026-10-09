import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * REC-3 (narrowed scope): the x402 agent route must never label a stored
 * image with the literal pseudo-user "x402-agent", must measure the MIME
 * type it stores from the actual bytes rather than assuming PNG, and must
 * record the generation through the same pipeline REC-1 uses when (and only
 * when) the paying wallet is already linked to a real Enki account — it has
 * no account to record under otherwise (generations.user_id is a NOT NULL
 * FK; see docs/specs/REC-3.md for why that is a decision this PR does not
 * make on its own).
 *
 * The settle-before-generate order is deliberately UNCHANGED by this PR
 * (docs/specs/REC-3.md, the STOP section) — not tested here as a "should be
 * reordered" assertion, because it should not be, yet, by this PR.
 */

const ROOT = join(__dirname, "..", "..");
const AGENT = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));

describe("the x402 route never uses the pseudo-user string", () => {
  it("does not store under the literal 'x402-agent' identity", () => {
    expect(AGENT).not.toMatch(/storeGeneratedImage\([^)]*["']x402-agent["']/);
    expect(AGENT).not.toContain('"x402-agent"');
  });

  it("uses the verified payer's wallet as the storage namespace", () => {
    const payer = AGENT.indexOf("const payerWallet = verified.payer.toBase58();");
    const store = AGENT.indexOf("storeGeneratedImage(dataUrl, payerWallet, storeDeadline(startedAt))");
    expect(payer).toBeGreaterThan(-1);
    expect(store).toBeGreaterThan(payer);
  });
});

describe("the x402 route measures MIME from bytes", () => {
  it("does not hard-code image/png when building the stored data URL", () => {
    expect(AGENT).not.toMatch(/data:image\/png;base64,\$\{buffer\.toString\("base64"\)\}/);
  });

  it("reads the format from the actual bytes before storing", () => {
    expect(AGENT).toMatch(/readImageDimensions\(buffer\)/);
  });
});

describe("the x402 route records through the shared pipeline exactly once, gated on a linked wallet", () => {
  it("calls recordGeneration exactly once, from after(), gated on resolveUserIdForWallet", () => {
    const count = (AGENT.match(/await recordGeneration\(/g) ?? []).length;
    expect(count).toBe(1);
    const after = AGENT.indexOf("after(async () => {\n    const recUserId = await resolveUserIdForWallet(supabase, payerWallet);");
    const guard = AGENT.indexOf("if (!recUserId) return;");
    const call = AGENT.indexOf("await recordGeneration(supabase, {");
    expect(after).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(after);
    expect(call).toBeGreaterThan(guard);
  });

  it("carries the settlement signature and chain key as the payment link, never a payment_intent_id", () => {
    expect(AGENT).toMatch(/transactionHash:\s*signature/);
    expect(AGENT).toMatch(/chainKey/);
    expect(AGENT).toMatch(/paymentIntentId:\s*null/);
  });

  it("still calls recordGenerationFailure exactly 4 times, unchanged from before REC-3", () => {
    // Pinned already by generation-failures.test.ts; re-asserted here so a
    // regression in THIS file's own suite catches it too, not just there.
    const count = (AGENT.match(/after\(recordGenerationFailure\(/g) ?? []).length;
    expect(count).toBe(4);
  });
});

describe("resolveUserIdForWallet", () => {
  let row: { user_id: string } | null;
  let lookupError: { message: string } | null;
  let lastEqArgs: [string, string] | null;

  function chain() {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, val: string) => { lastEqArgs = [col, val]; return q; },
      is: () => q,
      maybeSingle: async () => (lookupError ? { data: null, error: lookupError } : { data: row, error: null }),
    };
    return q;
  }
  const fake = { from: () => chain() } as unknown as SupabaseClient;

  beforeEach(() => {
    row = null;
    lookupError = null;
    lastEqArgs = null;
  });

  // Imported inside the suite so the module (and its storeGeneratedImage /
  // admin-notify imports) loads fresh per file, matching the project's style.
  it("resolves the linked user_id for a matching, non-removed wallet row", async () => {
    const { resolveUserIdForWallet } = await import("@/lib/generation/record");
    row = { user_id: "user-123" };
    const result = await resolveUserIdForWallet(fake, "SoMeBase58Address");
    expect(result).toBe("user-123");
    expect(lastEqArgs).toEqual(["address", "SoMeBase58Address"]);
  });

  it("resolves null when no wallet row matches", async () => {
    const { resolveUserIdForWallet } = await import("@/lib/generation/record");
    row = null;
    expect(await resolveUserIdForWallet(fake, "UnknownAddress")).toBeNull();
  });

  it("resolves null (and warns, not throws) when the lookup errors", async () => {
    const { resolveUserIdForWallet } = await import("@/lib/generation/record");
    lookupError = { message: "db down" };
    await expect(resolveUserIdForWallet(fake, "AnyAddress")).resolves.toBeNull();
  });

  it("resolves null for an empty address without querying", async () => {
    const { resolveUserIdForWallet } = await import("@/lib/generation/record");
    expect(await resolveUserIdForWallet(fake, "")).toBeNull();
  });
});
