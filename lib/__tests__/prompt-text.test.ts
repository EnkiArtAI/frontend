import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSource } from "@/lib/__tests__/_read-source";
import { loadPromptText, fillVariables } from "@/lib/generation/prompt-text";

/**
 * A paid marketplace prompt is generated from the ARTIST's text on the
 * server. The human rail generated from the client's text, which for a paid
 * prompt was only the title and the variables.
 */

const ROOT = join(__dirname, "..", "..");
const ROUTE = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
const AGENT = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));

function prompts(row: Record<string, unknown> | null, vars: Array<Record<string, unknown>> = []) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      maybeSingle: async () => ({ data: row, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: table === "prompt_variables" ? vars : null, error: null }).then(ok),
    };
    for (const m of ["select", "eq", "is"]) chain[m] = () => chain;
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

describe("fillVariables", () => {
  it("fills the [name] slots with the buyer's values and leaves unknown ones as written", () => {
    expect(fillVariables("a [animal] on a [place]", { animal: "fox" })).toBe("a fox on a [place]");
  });

  it("fills a slot the artist typed with spaces and capitals from the slugged name the values arrive under", () => {
    // app/api/prompt stores "[Character Design]" as character_design and keeps the text verbatim.
    const vars = [{ name: "character_design", label: "Character Design" }, { name: "v_2nd_subject", label: "2nd subject" }];
    expect(fillVariables("a [Character Design] with a [2nd subject]", { character_design: "knight", v_2nd_subject: "dog" }, vars))
      .toBe("a knight with a dog");
    // Without the stored list (an agent), the plain slug still finds it.
    expect(fillVariables("a [Character Design]", { character_design: "knight" })).toBe("a knight");
  });

  it("takes only text values of a sane length", () => {
    expect(fillVariables("[a] [b]", { a: 5, b: "x".repeat(2001) })).toBe("[a] [b]");
    expect(fillVariables("[a]", null)).toBe("[a]");
  });
});

describe("loadPromptText", () => {
  it("reads a prompt's public text when it has no encrypted body", async () => {
    expect(await loadPromptText(prompts({ public_prompt_text: "a [animal]" }, [{ name: "animal", label: "Animal" }]), "p")).toEqual({
      ok: true, text: "a [animal]", variables: [{ name: "animal", label: "Animal" }],
    });
  });

  it("refuses a prompt with no readable text rather than generating from nothing", async () => {
    expect(await loadPromptText(prompts({ public_prompt_text: "  " }), "p")).toMatchObject({ ok: false, status: 422 });
    expect(await loadPromptText(prompts(null), "p")).toMatchObject({ ok: false, status: 500 });
  });
});

describe("/api/generate-image builds a paid prompt from the artist's text", () => {
  it("composes when the intent carries an artist share, before moderation", () => {
    const compose = ROUTE.indexOf("prompt = fillVariables(text.text, body.variableValues, text.variables);");
    const moderate = ROUTE.indexOf("const verdict = await moderate({ prompt,");
    expect(ROUTE).toMatch(/const fromArtist = Boolean\(paid\.prompt_id\) && Number\(paid\.artist_amount_micro\) > 0;/);
    expect(compose).toBeGreaterThan(-1);
    expect(moderate).toBeGreaterThan(compose);
  });

  it("never returns the artist's text to the buyer, and records which prompt was used", () => {
    expect(ROUTE).toMatch(/prompt: fromArtist \? undefined : enhancedPrompt,/);
    expect(ROUTE).toMatch(/promptId: paid\.prompt_id \?\? null,/);
  });

  it("the agent route uses the same reader", () => {
    expect(AGENT).toMatch(/const text = await loadPromptText\(supabase, input\.promptId\);/);
    expect(AGENT).not.toMatch(/decryptPrompt/);
  });
});
