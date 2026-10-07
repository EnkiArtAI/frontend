import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { moderate, screenFirst } from "@/lib/moderation";

/**
 * The regex first, then the LLM (Kev, 2026-10-06). Every route ran the prompt
 * check, a chat-model call to OpenAI, before moderate() and so before Tier 1:
 * text matching a CSAM rule went out to a third party first. Each route now
 * runs Tier 1 alone over exactly the text the check would send, skips the
 * check when it refuses, and takes that refusal as its moderation verdict.
 */

describe("screenFirst", () => {
  it("passes clean text", () => {
    expect(screenFirst({ prompt: "family portrait with two children" })).toBeNull();
    expect(screenFirst({ prompt: "   " })).toBeNull();
  });

  it("refuses what Tier 1 refuses, with the verdict moderate() gives it", async () => {
    const first = screenFirst({ subject: "child porn" });
    const later = await moderate({ prompt: "child porn", surface: "generate-image" });
    expect(first).not.toBeNull();
    expect(first?.allowed).toBe(false);
    expect(first?.tier).toBe(1);
    expect(first?.category).toBe("csam");
    expect(first?.enforcement).toBe("review");
    expect({ ...first, elapsedMs: 0 }).toEqual({ ...later, elapsedMs: 0 });
  });

  it("reads every input, like the check does", () => {
    expect(screenFirst({ title: "Portrait", outfit: "child porn" })?.category).toBe("csam");
  });
});

const ROOT = join(__dirname, "..", "..", "..");
const ROUTES: Array<[string, string]> = [
  ["app/api/generate-image/route.ts", "checked"],
  ["app/api/generate-free/route.ts", "{ prompt }"],
  ["app/api/x402/generate/route.ts", "checked"],
  ["app/api/prompt/route.ts", "judged"],
  ["app/api/prompts/[id]/route.ts", "edited"],
];

describe("every route that runs the prompt check", () => {
  it.each(ROUTES)("%s screens the same inputs first, skips the check on a refusal and takes it as the verdict", (file, inputs) => {
    const src = readSource(join(ROOT, ...file.split("/")));
    const first = src.indexOf(`const first = screenFirst(${inputs});`);
    const check = src.indexOf(`const check = first ? NOT_CHECKED : await checkPrompt(${inputs}, `);
    const verdict = src.indexOf("const verdict = first ?? await moderate(");
    expect(first).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(first);
    expect(verdict).toBeGreaterThan(check);
    expect(src).not.toMatch(/const check = await checkPrompt\(/);
  });
});
