import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screenTier2 } from "@/lib/moderation/tier2-openai";

/**
 * Suggestive prompts are allowed for adults and marked 18+ (Kev, 2026-10-03),
 * but omni-moderation flags them "sexual" and the text filter blocked every
 * flagged prompt. A text the prompt check already judged leaves the plain
 * "sexual" flag to that judgement; every other category still blocks.
 */

function moderation(categories: Record<string, boolean>, scores: Record<string, number> = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    results: [{ flagged: Object.values(categories).some(Boolean), categories, category_scores: scores }],
  }), { status: 200 })));
}

beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-real-one"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("tier 2 after the prompt check", () => {
  it("still blocks a plain sexual flag when the prompt check did not judge the text", async () => {
    moderation({ sexual: true });
    expect((await screenTier2("a seductive pose")).blocked).toBe(true);
  });

  it("leaves a plain sexual flag to the prompt check's judgement", async () => {
    moderation({ sexual: true });
    expect((await screenTier2("a seductive pose", undefined, true)).blocked).toBe(false);
  });

  it("still blocks every other category", async () => {
    moderation({ sexual: true, "violence/graphic": true });
    expect((await screenTier2("gore", undefined, true)).blocked).toBe(true);
  });

  it("still blocks sexual content involving minors", async () => {
    moderation({ sexual: true, "sexual/minors": true }, { "sexual/minors": 0.95 });
    expect(await screenTier2("x", undefined, true)).toMatchObject({ blocked: true, category: "sexual/minors" });
  });
});

describe("moderate passes the judgement on", () => {
  it("allows a judged suggestive text and blocks an unjudged one", async () => {
    const { moderate } = await import("@/lib/moderation");
    moderation({ sexual: true });
    expect((await moderate({ prompt: "a seductive pose", surface: "generate-image", adultJudged: true })).allowed).toBe(true);
    moderation({ sexual: true });
    expect((await moderate({ prompt: "a seductive pose", surface: "generate-image" })).allowed).toBe(false);
  });
});
