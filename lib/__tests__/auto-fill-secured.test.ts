import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The editor's Auto Fill posted to /api/grok-fill, which had no session, no
 * rate limit and no validation of what came back: anyone past the team gate
 * could spend our xAI key freely (Kev, 2026-10-06). It now goes through the
 * dice endpoint, which has all three.
 */

const EDITOR = readSource(join(__dirname, "..", "..", "components", "EnkiPromptEditor.tsx"));
const at = EDITOR.indexOf("const handleGrokFill = async () => {");
const AUTO_FILL = EDITOR.slice(at, EDITOR.indexOf("\n  };\n", at));

describe("the editor's Auto Fill", () => {
  it("exists", () => {
    expect(at).toBeGreaterThan(-1);
  });

  it("posts to the dice endpoint with the session", () => {
    expect(AUTO_FILL).toMatch(/fetch\("\/api\/workflow\/variables", \{/);
    expect(AUTO_FILL).toMatch(/headers: \{ "Content-Type": "application\/json", \.\.\.sessionAuthHeaders\(\) \}/);
  });

  it("asks only for the empty variables and applies validated values", () => {
    expect(AUTO_FILL).toMatch(/variables: diceVariables\.filter\(v => emptyIds\.has\(v\.id\)\)/);
    expect(AUTO_FILL).toMatch(/applyDiceValues\(values\);/);
  });

  it("no longer calls the unguarded endpoint anywhere", () => {
    expect(EDITOR).not.toMatch(/\/api\/grok-fill/);
  });
});
