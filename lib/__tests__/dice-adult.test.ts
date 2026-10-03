import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Dice on a stored prompt return its variables and option values, so an 18+
 * prompt answers like a missing one to anyone who may not see it, and a
 * prompt that cannot be read answers nothing (round-2 review, 2026-10-03).
 * Every path tested here returns before the dice model is asked; the suite's
 * fetch guard (vitest.setup.ts) throws on any real call regardless.
 */

let prompt: Record<string, unknown> | null;
let promptFails = false;

const chain = (table: string) => {
  const q = {
    select: () => q, eq: () => q, is: () => q, order: () => q,
    maybeSingle: async () => {
      if (table === "users") return { data: { adult_confirmed_at: null }, error: null };
      return promptFails ? { data: null, error: { message: "fetch failed" } } : { data: prompt, error: null };
    },
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
  };
  return q;
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: chain }) }));
vi.mock("@/lib/auth", () => ({ requireAuth: async () => ({ userId: "wallet-1" }), checkRateLimit: () => true }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async (_s: unknown, t: string | null) => (t === "owner-tok" ? "owner" : t ? "someone" : null) }));

import { POST } from "../../app/api/workflow/variables/route";

const roll = (token: string) => POST(new NextRequest("http://enki.test/api/workflow/variables", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Session-Token": token, "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` },
  body: JSON.stringify({ promptId: "11111111-1111-4111-8111-111111111111" }),
}));

beforeEach(() => {
  vi.stubEnv("XAI_API_KEY", "not-a-real-key");
  prompt = { public_prompt_text: "x", is_adult: true, creator_id: "owner" };
  promptFails = false;
});
afterEach(() => vi.unstubAllEnvs());

describe("dice on a stored prompt", () => {
  it("answer an 18+ prompt like a missing one to someone who may not see it", async () => {
    expect((await roll("someone-tok")).status).toBe(404);
  });

  it("answer nothing when the prompt cannot be read", async () => {
    promptFails = true;
    expect((await roll("someone-tok")).status).toBe(500);
  });
});
