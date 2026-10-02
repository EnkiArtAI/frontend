import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Where the extraction check sits: on both paid rails, on the buyer's values,
 * before moderation and before any money moves.
 */

const ROOT = join(__dirname, "..", "..", "..");
const HUMAN = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
const AGENT = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));

describe("the human rail", () => {
  const check = HUMAN.indexOf("await checkExtraction(values, request.signal)");

  it("checks an artist's prompt after composing it", () => {
    expect(check).toBeGreaterThan(HUMAN.indexOf("const filled = fillVariables("));
  });

  it("checks before moderation and before the charge", () => {
    expect(HUMAN.indexOf("const verdict = await moderate({ prompt,")).toBeGreaterThan(check);
    expect(HUMAN.indexOf("await claimForGeneration(")).toBeGreaterThan(check);
  });

  it("answers anything but a clear verdict with the ordinary failure", () => {
    expect(HUMAN).toMatch(/if \(check\.verdict !== "clear"\) return NextResponse\.json\(SILENT_FAILURE, \{ status: 500 \}\);/);
  });

  it("checks only the buyer's values", () => {
    expect(HUMAN).toMatch(/const values = textValues\(body\.variableValues\);/);
  });
});

describe("the agent rail", () => {
  const check = AGENT.indexOf("await checkExtraction(values)");

  it("stops a blocked address before checking", () => {
    expect(AGENT.indexOf("await agentBlocked(supabase, request)")).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(AGENT.indexOf("await agentBlocked(supabase, request)"));
  });

  it("checks before any payment is read", () => {
    expect(check).toBeGreaterThan(-1);
    expect(AGENT.indexOf("parseXPayment(paymentHeader)")).toBeGreaterThan(check);
  });

  it("answers anything but a clear verdict with the ordinary failure", () => {
    expect(AGENT).toMatch(/if \(check\.verdict !== "clear"\) return NextResponse\.json\(SILENT_FAILURE, \{ status: 500 \}\);/);
  });
});
