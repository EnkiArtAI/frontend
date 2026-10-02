import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The dice asks xAI for variable values and sends the prompt's stored excerpt
 * as context. For a paid prompt that excerpt was the artist's secret text,
 * sent to a third party on every roll.
 */

let promptRow: Record<string, unknown>;

vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {
        maybeSingle: async () => ({ data: promptRow, error: null }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({
            data: table === "prompt_variables" ? [{ name: "subject", label: "Subject", data_type: "text" }] : [],
            error: null,
          }).then(ok),
      };
      for (const m of ["select", "eq", "is", "order"]) q[m] = () => q;
      return q;
    },
  }),
}));
vi.mock("@/lib/auth", () => ({ requireAuth: async () => ({ userId: "u1" }), checkRateLimit: () => true }));
vi.mock("@/lib/rate-limit", () => ({
  checkRequestRateLimit: () => ({ allowed: true }),
  rateLimitKey: () => "k",
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));

import { POST as dice } from "../../app/api/workflow/variables/route";

const SECRET = "the artist's secret words around [subject]";

async function sentToXai(): Promise<string> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await dice(new NextRequest("http://localhost/api/workflow/variables", {
    method: "POST",
    body: JSON.stringify({ promptId: "11111111-1111-4111-8111-111111111111" }),
  }));
  return String(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body);
}

beforeEach(() => vi.stubEnv("XAI_API_KEY", "test-key"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("a dice roll's context", () => {
  it("never carries a paid prompt's words", async () => {
    promptRow = { prompt_type: "paid", public_prompt_text: SECRET, title: "Moody", description: "A portrait" };
    expect(await sentToXai()).not.toContain("secret words");
  });

  it("gives a paid prompt its title and description instead", async () => {
    promptRow = { prompt_type: "paid", public_prompt_text: SECRET, title: "Moody", description: "A portrait" };
    expect(await sentToXai()).toContain("Moody - A portrait");
  });

  it("keeps a free prompt's excerpt", async () => {
    promptRow = { prompt_type: "free", public_prompt_text: "a free [subject]", title: "Free" };
    expect(await sentToXai()).toContain("a free [subject]");
  });
});
