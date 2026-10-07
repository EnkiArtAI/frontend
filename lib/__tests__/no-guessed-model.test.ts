import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";
import { generateImagesWithWaveSpeed } from "@/backend/services/wavespeed-image-generation";
import { generateImagesWithOpenAI } from "@/backend/services/openai-image-generation";
import { generateImagesWithGemini } from "@/backend/services/gemini-image-generation";

/**
 * ENG-01. Rule (Kev, 2026-09-22): a paid request never falls back to a guessed
 * model. The agent route built its provider request without modelVersion, so
 * every adapter picked its own default: gpt-image-2 at quality high landed on
 * WaveSpeed's nano-banana-pro default, the wrong model billed as gpt high.
 */

const ROOT = join(__dirname, "..", "..");
const X402 = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));

describe("the agent route sends the routed model", () => {
  it("passes route.providerModel as modelVersion, like the human route", () => {
    expect(X402).toMatch(/const genRequest: ImageGenerationRequest = \{[^}]*modelVersion: route\.providerModel,/);
  });

  it("refuses a route without a provider model, or on a host it cannot call, before any money moves", () => {
    const hosts = X402.search(/if \(!\["gemini", "wavespeed", "openai"\]\.includes\(route\.provider\)\) \{/);
    const guard = X402.search(/if \(!route\.providerModel\) \{/);
    // Money first moves when the fee payer fronts a missing token account,
    // then at settlement. Reading the payment header moves nothing; it runs
    // before the routing on purpose (Kev, 2026-10-06).
    const fronting = X402.search(/await broadcastAndConfirm\(conn, fronted\.serialize\(\)/);
    const settle = X402.search(/await submitAndConfirm\(solanaConnection\(\), parsed\.tx\)/);
    expect(hosts).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(hosts);
    expect(fronting).toBeGreaterThan(guard);
    expect(settle).toBeGreaterThan(fronting);
    expect(X402).not.toMatch(/pollinations-image-generation/);
  });

  it("requires the agent to name its model: there is no default", () => {
    expect(X402).toMatch(/modelFamily: z\.string\(\{ error: "modelFamily is required" \}\)\.trim\(\)\.min\(1, "modelFamily is required"\)\.max\(64\),/);
    expect(X402).not.toMatch(/\.default\("nano-banana-pro"\)/);
  });
});

describe("every paid adapter refuses a request without a model", () => {
  afterEach(() => vi.unstubAllEnvs());

  const adapters = [
    ["WaveSpeed", generateImagesWithWaveSpeed, "WAVESPEED_API_KEY"],
    ["OpenAI", generateImagesWithOpenAI, "OPENAI_API_KEY"],
    ["Gemini", generateImagesWithGemini, "GEMINI_API_KEY"],
  ] as const;

  for (const [name, generate, keyVar] of adapters) {
    it(`${name}: no modelVersion means MODEL_REQUIRED, not a default model`, async () => {
      // A configured key, so the refusal cannot come from a missing key.
      vi.stubEnv(keyVar, "test-key");
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const result = await generate({ prompt: "a red cube", aspectRatio: "1:1", numImages: 1 });
      expect(result.success).toBe(false);
      expect(result.code).toBe("MODEL_REQUIRED");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  }
});

describe("the human route refuses a route without a provider model before payment", () => {
  const HUMAN = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
  it("guards next to the IMPLEMENTED check, before the concurrency slot and any payment step", () => {
    const guard = HUMAN.search(/if \(!preflightRoute\.providerModel\) \{/);
    const slot = HUMAN.search(/const slot = await acquireSlot\(/);
    expect(guard).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(guard);
  });
});

// Live code only: tests may name the dead ids to prove they are gone.
const DEAD_IDS = ["gemini-2.5-flash-image", "gemini-3-pro-image-preview", "gemini-1.5-flash"];
function liveFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === "__tests__" || n === "scripts" || n.startsWith(".")) return [];
    if (statSync(p).isDirectory()) return liveFiles(p);
    return /\.(ts|tsx|js|mjs)$/.test(n) ? [p] : [];
  });
}

describe("no live code names a Gemini model Google has shut down", () => {
  const files = ["app", "lib", "components", "hooks", "backend"].flatMap((d) => liveFiles(join(ROOT, d)));
  it("scans a real set of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });
  for (const id of DEAD_IDS) {
    it(`${id} appears nowhere, comments included`, () => {
      const hits = files.filter((f) => readFileSync(f, "utf8").includes(id));
      expect(hits).toEqual([]);
    });
  }
});

describe("there is no fallback model: a pick that cannot be resolved is refused", () => {
  const MODELS = readSource(join(ROOT, "lib", "generation", "models.ts"));
  const HUMAN = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
  const NBP = { id: "11111111-1111-4111-8111-111111111111", name: "Nano Banana Pro", model_providers: [] };
  const GPT = { id: "22222222-2222-4222-8222-222222222222", name: "GPT-Image-2", model_providers: [] };

  // The query chain resolveModel uses: from().select().in("id", ids).eq("active", true)
  function db(rows: object[], fail?: "error" | "throw") {
    const result = (ids: string[]) =>
      fail === "throw" ? Promise.reject(new Error("db down"))
      : fail === "error" ? Promise.resolve({ data: null, error: { message: "boom" } })
      : Promise.resolve({ data: rows.filter((r) => ids.includes((r as { id: string }).id)), error: null });
    return { from: () => ({ select: () => ({ in: (_c: string, ids: string[]) => ({ eq: () => result(ids) }) }) }) } as never;
  }

  it("the models module has no default model any more", () => {
    expect(MODELS).not.toMatch(/DEFAULT_MODEL/);
  });

  it("a GPT-Image-2 pick resolves to GPT-Image-2 and a Nano Banana Pro pick to Nano Banana Pro", async () => {
    const { resolveModel } = await import("@/lib/generation/models");
    expect((await resolveModel(db([NBP, GPT]), [GPT.id]))?.name).toBe("GPT-Image-2");
    expect((await resolveModel(db([NBP, GPT]), [NBP.id]))?.name).toBe("Nano Banana Pro");
  });

  it("never returns Nano Banana Pro for a pick that cannot be resolved", async () => {
    const { resolveModel } = await import("@/lib/generation/models");
    expect(await resolveModel(db([NBP, GPT]), ["gpt-image-2"])).toBeNull(); // a slug is not an id
    expect(await resolveModel(db([NBP]), [GPT.id])).toBeNull(); // inactive or missing row
    expect(await resolveModel(db([NBP, GPT]), [])).toBeNull(); // nothing chosen
    expect(await resolveModel(null, [GPT.id])).toBeNull(); // no database
    expect(await resolveModel(db([NBP, GPT], "error"), [GPT.id])).toBeNull();
    expect(await resolveModel(db([NBP, GPT], "throw"), [GPT.id])).toBeNull();
  });

  it("the human route refuses an unresolved pick before any payment step", () => {
    const refuse = HUMAN.search(/if \(!paidTier \|\| !paidModel \|\| toModelFamily\(paidModel\.name\) !== paid\.model_family\) \{/);
    const slot = HUMAN.search(/const slot = await acquireSlot\(/);
    expect(refuse).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(refuse);
  });
});
