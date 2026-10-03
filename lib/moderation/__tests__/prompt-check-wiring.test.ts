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

const SILENT = /const silent = ((blocked|warnedOut) \|\| )?check\.verdict !== "clear";/;
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

  it("fails a silent refusal only where a real generation fails: after login, slot and claim", () => {
    const at = HUMAN.indexOf("    if (silent) {");
    expect(at).toBeGreaterThan(HUMAN.indexOf('return NextResponse.json({ error: "Authentication required" }, { status: 401 });'));
    expect(at).toBeGreaterThan(HUMAN.indexOf("consumedIntent = { supabase, id: intentId, mode: redemption.mode };"));
    expect(HUMAN.indexOf("generateImagesWithWaveSpeed(shared)")).toBeGreaterThan(at);
    expect(HUMAN).toMatch(/if \(silent\) \{\n[\s\S]{0,600}const answer = await silentFailure\(\);\n\s+await releaseIfConsumed\(\);\n\s+await releaseHeldSlot\(\);\n\s+return answer;/);
  });

  it("has no other, earlier silent answer", () => {
    expect(HUMAN.split("await silentFailure()").length - 1).toBe(1);
    expect(HUMAN.split("return silentFailure();").length - 1).toBe(0);
    expect(AGENT.split("return silentFailure();").length - 1).toBe(1);
    expect(FREE.split("return silentFailure();").length - 1).toBe(1);
  });

  it("counts a caught attempt only once it got that far", () => {
    expect(HUMAN.indexOf("recordExtractionHit(")).toBeGreaterThan(HUMAN.indexOf("    if (silent) {"));
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

  it("fails silently only after the sign-in and quota answers", () => {
    const at = FREE.indexOf("    if (silent) return silentFailure();");
    expect(at).toBeGreaterThan(FREE.indexOf('error: "Sign in to generate for free."'));
    expect(FREE.indexOf("await generateImageWithPollinations(")).toBeGreaterThan(at);
  });

  it("gives a slow silent answer the time it needs", () => {
    expect(FREE).toMatch(/export const maxDuration = 300;/);
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
    const blocked = AGENT.indexOf("const blocked = (await agentBlocked(supabase, request)) || (await addressWarnedOut(supabase, request));");
    expect(blocked).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(blocked);
    // Judged like everyone else, so nothing before the silent point differs.
    expect(AGENT).toMatch(/const check = await checkPrompt\(checked, \{ hidden: reqs\.legs\.length > 1 \}\);/);
    expect(FREE).toMatch(/const check = await checkPrompt\(\{ prompt \}, \{ hidden: false, signal: request\.signal \}\);/);
    expect(FREE).toMatch(/const silent = warnedOut \|\| check\.verdict !== "clear";/);
  });

  it("fails silently only once the payment is simulated with its signatures, and before it settles", () => {
    const at = AGENT.indexOf("  if (silent) {");
    const sim = AGENT.indexOf("const simulated = await simulatePayment(solanaConnection(), parsed.tx);");
    expect(sim).toBeGreaterThan(AGENT.indexOf("const signature = cosignAsFeePayer(parsed.tx, feePayer);"));
    expect(at).toBeGreaterThan(AGENT.indexOf("if (!simulated.ok) {", sim));
    expect(AGENT.indexOf("submitAndConfirm(")).toBeGreaterThan(at);
  });

  it("answers a real failure with a fixed sentence, never the provider's", () => {
    expect(AGENT).not.toMatch(/error: result\.error \|\|/);
    expect(AGENT).toMatch(/error: "Image generation failed after your payment settled\.",/);
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

describe("an agent payment that already landed", () => {
  it("is answered as the replay it is, before anything else is decided", () => {
    const replay = AGENT.indexOf('if (!simulated.ok && simulated.error.includes("AlreadyProcessed")) {');
    expect(replay).toBeGreaterThan(AGENT.indexOf("const simulated = await simulatePayment("));
    expect(AGENT.indexOf("  if (silent) {")).toBeGreaterThan(replay);
    expect(AGENT.slice(replay, replay + 300)).toMatch(/This payment transaction was already settled", transaction: signature \}, \{ status: 409 \}/);
  });
});
