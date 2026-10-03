import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSource } from "@/lib/__tests__/_read-source";
import { loadPromptText, fillVariables, inputsUnmatched, overLong, VALUE_MAX } from "@/lib/generation/prompt-text";

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
    for (const m of ["select", "eq", "is", "order"]) chain[m] = () => chain;
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

describe("fillVariables", () => {
  it("fills the [name] slots with the buyer's values and leaves unknown ones as written", () => {
    expect(fillVariables("a [animal] on a [place]", { animal: "fox" }).text).toBe("a fox on a [place]");
  });

  it("fills a slot from the name app/api/prompt stored it under, as the editor saves it", () => {
    // Editor-shaped rows: the label is the text the artist SELECTED, never the slot.
    const vars = [{ name: "character_design" }, { name: "v_1st_animal" }];
    const f = fillVariables("a [Character Design] and a [1st animal] at dusk", { character_design: "knight", v_1st_animal: "wolf" }, vars);
    expect(f.text).toBe("a knight and a wolf at dusk");
    expect(inputsUnmatched(f)).toBe(false);
    // Without the stored list (an agent), the plain slug still finds it.
    expect(fillVariables("a [Character Design]", { character_design: "knight" }).text).toBe("a knight");
  });

  it("never hands one variable's value to another", () => {
    // Hero (selected "knight") and Knight (selected "templar"): labels would have crossed them.
    const f = fillVariables("[Hero] faces the [Knight]", { hero: "elf", knight: "paladin" }, [{ name: "hero" }, { name: "knight" }]);
    expect(f.text).toBe("elf faces the paladin");
  });

  it("refuses inputs it cannot place with certainty", () => {
    // Two slots that slug alike: saved as hero and hero_2, the text cannot say which is which.
    expect(inputsUnmatched(fillVariables("[Hero] and [hero!]", { hero: "a", hero_2: "b" }, [{ name: "hero" }, { name: "hero_2" }]))).toBe(true);
    // A name with no ASCII letters is saved as var_N: its value arrives, its slot stays unfilled.
    expect(inputsUnmatched(fillVariables("a [竜]", { var_1: "dragon" }, [{ name: "var_1" }]))).toBe(true);
    // An optional slot left without a value is not a mismatch.
    expect(inputsUnmatched(fillVariables("a [animal] [mood]", { animal: "fox" }, [{ name: "animal" }, { name: "mood" }]))).toBe(false);
  });

  it("treats one slot written with and without inner spaces as one variable", () => {
    // The save route trims slots before matching them to names.
    const f = fillVariables("[subject] and [ subject ]", { subject: "fox" }, [{ name: "subject" }]);
    expect(f.text).toBe("fox and fox");
    expect(inputsUnmatched(f)).toBe(false);
  });

  it("tells a typed name from a tie-break", () => {
    // A longer name that merely starts the same is no tie-break.
    expect(inputsUnmatched(fillVariables("[hero] and [hero name]", { hero: "a", hero_name: "b" }, [{ name: "hero" }, { name: "hero_name" }]))).toBe(false);
    expect(inputsUnmatched(fillVariables("[hero]", { hero: "a" }, [{ name: "hero" }, { name: "hero_name" }]))).toBe(false);
    // "hero 2" typed by the artist is its own variable, saved as hero_2.
    expect(inputsUnmatched(fillVariables("[hero] and [hero 2]", { hero: "a", hero_2: "b" }, [{ name: "hero" }, { name: "hero_2" }]))).toBe(false);
    // "subject" and " subject " saved as subject and subject_2: both slots trim alike, so which is which is a guess.
    expect(inputsUnmatched(fillVariables("[subject] [ subject ]", { subject: "a", subject_2: "b" }, [{ name: "subject" }, { name: "subject_2" }]))).toBe(true);
    // "Hero", "hero!" and a typed "hero 2" (saved hero, hero_2, hero_2_2): hero_2 is named by a slot,
    // yet two different slots still answer to hero.
    expect(inputsUnmatched(fillVariables("[Hero] [hero!] [hero 2]", { hero: "a", hero_2: "b", hero_2_2: "c" },
      [{ name: "hero" }, { name: "hero_2" }, { name: "hero_2_2" }]))).toBe(true);
    // Saved in the order "hero 2", "Hero", "hero!": hero_2 is typed, the collision went to hero_3.
    expect(inputsUnmatched(fillVariables("[hero 2] [Hero] [hero!]", { hero_2: "a", hero: "b", hero_3: "c" },
      [{ name: "hero_2" }, { name: "hero" }, { name: "hero_3" }]))).toBe(true);
  });

  it("pins the decided limit of 300 characters", () => {
    // Kev, 2026-10-02: "lass sie bei 300 zeichen bitte".
    expect(VALUE_MAX).toBe(300);
  });

  it("names the first value over the limit", () => {
    expect(overLong({ a: "fox", b: "x".repeat(VALUE_MAX + 1) })).toBe("b");
    expect(overLong({ a: "x".repeat(VALUE_MAX) })).toBeNull();
  });

  it("takes only text values of a sane length", () => {
    expect(fillVariables("[a] [b]", { a: 5, b: "x".repeat(VALUE_MAX + 1) }).text).toBe("[a] [b]");
    expect(fillVariables("[a]", { a: "x".repeat(VALUE_MAX) }).text).toBe("x".repeat(VALUE_MAX));
    expect(fillVariables("[a]", null).text).toBe("[a]");
  });
});

describe("loadPromptText", () => {
  it("reads a prompt's public text when it has no encrypted body", async () => {
    expect(await loadPromptText(prompts({ public_prompt_text: "a [animal]" }, [{ name: "animal" }]), "p")).toEqual({
      ok: true, text: "a [animal]", variables: [{ name: "animal" }], adult: false,
    });
  });

  it("carries the prompt's 18+ mark", async () => {
    expect(await loadPromptText(prompts({ public_prompt_text: "a [animal]", is_adult: true }), "p")).toMatchObject({ ok: true, adult: true });
  });

  it("never serves a priced prompt from its public excerpt", async () => {
    const excerpt = { public_prompt_text: "the first 220 characters", price_usd_cents: 150, prompt_type: "premium-prompt" };
    expect(await loadPromptText(prompts(excerpt), "p")).toMatchObject({ ok: false, status: 500 });
    expect(await loadPromptText(prompts({ ...excerpt, encrypted_content: "garbage", encrypted_content_iv: "x", encrypted_content_tag: "y" }), "p"))
      .toMatchObject({ ok: false, status: 500 });
    // A free or showcase prompt is public text: the excerpt is its text.
    expect(await loadPromptText(prompts({ ...excerpt, prompt_type: "free-prompt" }), "p")).toMatchObject({ ok: true });
  });

  it("refuses a prompt with no readable text rather than generating from nothing", async () => {
    expect(await loadPromptText(prompts({ public_prompt_text: "  " }), "p")).toMatchObject({ ok: false, status: 422 });
    expect(await loadPromptText(prompts(null), "p")).toMatchObject({ ok: false, status: 500 });
  });
});

describe("/api/generate-image builds a paid prompt from the artist's text", () => {
  it("composes when the intent carries an artist share, before moderation", () => {
    const compose = ROUTE.indexOf("const filled = fillVariables(text.text, body.variableValues, text.variables);");
    const moderate = ROUTE.indexOf("const verdict = await moderate({ prompt,");
    expect(ROUTE).toMatch(/const fromArtist = Boolean\(paid\.prompt_id\) && Number\(paid\.artist_amount_micro\) > 0;/);
    expect(compose).toBeGreaterThan(-1);
    expect(moderate).toBeGreaterThan(compose);
  });

  it("refuses unmatched inputs before moderation and before the claim, on both rails", () => {
    const refuse = ROUTE.search(/if \(inputsUnmatched\(filled\)\) \{\n\s+return NextResponse\.json\(/);
    expect(refuse).toBeGreaterThan(-1);
    expect(ROUTE.indexOf("const verdict = await moderate({ prompt,")).toBeGreaterThan(refuse);
    expect(ROUTE.indexOf("await claimForGeneration(")).toBeGreaterThan(refuse);
    // The agent rail refuses in agentPrompt, which settlement calls before reading the payment.
    const helper = AGENT.slice(AGENT.indexOf("async function agentPrompt("), AGENT.indexOf("async function requirementsFor("));
    expect(helper).toMatch(/if \(inputsUnmatched\(filled\)\) \{\n\s+return \{ ok: false, status: 422,/);
    const settle = AGENT.indexOf("const reqs = await requirementsFor(input);", AGENT.indexOf("async function settleAndGenerate("));
    expect(settle).toBeGreaterThan(-1);
    expect(AGENT.indexOf("parseXPayment(paymentHeader)")).toBeGreaterThan(settle);
  });

  it("never returns the artist's text to the buyer, and records which prompt was used", () => {
    expect(ROUTE).toMatch(/prompt: fromArtist \? undefined : enhancedPrompt,/);
    expect(ROUTE).toMatch(/promptId: paid\.prompt_id \?\? null,/);
  });

  it("the agent route uses the same reader", () => {
    expect(AGENT).toMatch(/const text = await loadPromptText\(supabase, promptId\);/);
    expect(AGENT).not.toMatch(/decryptPrompt/);
  });
});

describe("no adapter writes prompt text to the shared logs", () => {
  it.each(["gemini-image-generation.ts", "pollinations-image-generation.ts", "wavespeed-image-generation.ts", "openai-image-generation.ts"])("%s", (f) => {
    const src = readSource(join(ROOT, "backend", "services", f));
    expect(src).not.toMatch(/console\.\w+\([^)]*prompt\.(substring|slice)\(/i);
  });
});
