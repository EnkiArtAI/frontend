import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Where the prompt check sits: on every generation route, before moderation
 * and before any money moves; an artist's prompt is judged on the buyer's
 * values only.
 */

const ROOT = join(__dirname, "..", "..", "..");
const HUMAN = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
const FREE = readSource(join(ROOT, "app", "api", "generate-free", "route.ts"));
const AGENT = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));

const SILENT = /if \(check\.verdict !== "clear"\) return silentFailure\(\);/;
const WARNED = /return NextResponse\.json\(\{ error: warningMessage\(check\.verdict, outcome\) \}, \{ status: 422 \}\);/;

describe("a real generation failure", () => {
  it("answers exactly like a caught request", () => {
    for (const src of [HUMAN, FREE]) {
      expect(src).not.toMatch(/NextResponse\.json\(\s*\{ error: (geminiResult|result)\.error/);
      expect(src).not.toMatch(/return NextResponse\.json\(\{ error: message \}, \{ status: 500 \}\);/);
    }
    expect(HUMAN.split("return NextResponse.json(SILENT_FAILURE, { status: 500 });").length - 1).toBe(3);
    expect(FREE.split("return NextResponse.json(SILENT_FAILURE, { status: 500 });").length - 1).toBe(3);
  });
});

describe("the human rail", () => {
  const check = HUMAN.indexOf("await checkPrompt(checked, { hidden: fromArtist, signal: request.signal })");

  it("judges an artist's prompt on the buyer's values and an own prompt whole", () => {
    expect(HUMAN).toMatch(/const checked = fromArtist \? textValues\(body\.variableValues\) : \{ prompt \};/);
  });

  it("checks after composing, before moderation and before the charge", () => {
    expect(check).toBeGreaterThan(HUMAN.indexOf("const filled = fillVariables("));
    expect(HUMAN.indexOf("const verdict = await moderate({ prompt,")).toBeGreaterThan(check);
    expect(HUMAN.indexOf("await claimForGeneration(")).toBeGreaterThan(check);
  });

  it("warns on an explicit or child-safety request", () => {
    expect(HUMAN).toMatch(WARNED);
  });

  it("answers anything else that is refused with the ordinary failure", () => {
    expect(HUMAN).toMatch(SILENT);
  });
});

describe("the free generator", () => {
  const check = FREE.indexOf("await checkPrompt({ prompt }, { hidden: false, signal: request.signal })");

  it("checks the whole prompt before moderation and before rendering", () => {
    expect(check).toBeGreaterThan(-1);
    expect(FREE.indexOf("const verdict = await moderate({ prompt, surface: \"generate-free\"")).toBeGreaterThan(check);
    expect(FREE.indexOf("generateImageWithPollinations(")).toBeGreaterThan(check);
  });

  it("stops an address that reached the first step", () => {
    expect(FREE.indexOf("await addressWarnedOut(supabaseForChecks, request)")).toBeGreaterThan(-1);
  });

  it("warns, and fails closed otherwise", () => {
    expect(FREE).toMatch(WARNED);
    expect(FREE).toMatch(SILENT);
  });
});

describe("the agent rail", () => {
  const check = AGENT.indexOf("await checkPrompt(checked, { hidden: reqs.legs.length > 1 })");

  it("judges a marketplace prompt on the agent's values and an own prompt whole", () => {
    expect(AGENT).toMatch(/const checked = input\.promptId \? textValues\(input\.variableValues\) : \{ prompt: promptText \};/);
  });

  it("stops a blocked address before checking", () => {
    const blocked = AGENT.indexOf("await agentBlocked(supabase, request) || await addressWarnedOut(supabase, request)");
    expect(blocked).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(blocked);
  });

  it("checks before any payment is read", () => {
    expect(check).toBeGreaterThan(-1);
    expect(AGENT.indexOf("parseXPayment(paymentHeader)")).toBeGreaterThan(check);
  });

  it("warns, and fails closed otherwise", () => {
    expect(AGENT).toMatch(WARNED);
    expect(AGENT).toMatch(SILENT);
  });
});

describe("the 300-character limit", () => {
  it("refuses an over-long value on the human rail before composing", () => {
    const refuse = HUMAN.indexOf("if (overLong(body.variableValues)) {");
    expect(refuse).toBeGreaterThan(-1);
    expect(HUMAN.indexOf("const filled = fillVariables(")).toBeGreaterThan(refuse);
  });

  it("refuses an over-long value on the agent rail in its schema", () => {
    expect(AGENT).toMatch(/variableValues: z\.record\(z\.string\(\), z\.string\(\)\.max\(VALUE_MAX\)\)/);
  });
});
