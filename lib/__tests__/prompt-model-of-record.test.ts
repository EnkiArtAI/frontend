import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * A saved prompt's model is the one its creator picked. It defaulted to
 * "gemini", which is no catalogue row, and a re-save without a model
 * overwrote the creator's pick with it.
 */
const ROUTE = readSource(join(__dirname, "..", "..", "app", "api", "prompt", "route.ts"));

describe("POST /api/prompt keeps the creator's model", () => {
  it("never writes a default model", () => {
    expect(ROUTE).not.toMatch(/\?\? "gemini"/);
    expect(ROUTE).toMatch(/\.\.\.\(aiModel \? \{ ai_model: aiModel \} : \{\}\),/);
  });

  it("refuses a new prompt without a model, before it is inserted", () => {
    const refuse = ROUTE.search(/if \(!body\.id && !aiModel\) \{\n\s+return NextResponse\.json\(\{ error: "Pick the model this prompt is made for\." \}, \{ status: 400 \}\);/);
    expect(refuse).toBeGreaterThan(-1);
    expect(ROUTE.indexOf(".insert(", refuse)).toBeGreaterThan(refuse);
  });
});
