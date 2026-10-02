import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * REC-4: every paid generation goes through the intent rail (quote, intent,
 * authorize, sign, submit, generate with the intentId). The legacy X-PAYMENT
 * rail paid first and generated second, so a failed generation kept the money.
 */

const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readSource(join(ROOT, ...p));

describe("the classic editor", () => {
  const EDITOR = src("components", "EnkiPromptEditor.tsx");

  it("no longer imports the legacy payment hooks", () => {
    expect(EDITOR).not.toMatch(/useSolanaX402Payment|useX402PaymentProduction/);
  });

  it("holds a payment with the buyer's wallet and generates with the intent", () => {
    expect(EDITOR).toMatch(/await authorizePaidGeneration\(\s*\{ modelFamily: toModelFamily\(picked\.name\)/);
    expect(EDITOR).toMatch(/signPayment,\s*\);/);
    expect(EDITOR).toMatch(/intentId,\s*prompt: previewText,/);
    // The id of the model it priced, so the server refuses a mismatch.
    expect(EDITOR).toMatch(/modelIds: \[picked\.id\],/);
  });
});
