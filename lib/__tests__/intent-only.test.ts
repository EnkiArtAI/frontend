import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
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

  it("generates through runGeneration with the selected entry, never by prompt type", () => {
    expect(EDITOR).toMatch(/const picked = resolveCatalogueEntry\(catalogue, models\.selected\[0\]\);/);
    expect(EDITOR).toMatch(/const outcome = await runGeneration\(\n\s+\{\n\s+model: picked,/);
    // Display Mode stays a marketplace setting; it no longer picks the route.
    expect(EDITOR).not.toMatch(/isFreePrompt|\/api\/generate-free/);
  });

  it("selects nothing on its own and runs one model", () => {
    expect(EDITOR).not.toMatch(/fetchedModels\[0\]\.id/);
    expect(EDITOR).not.toMatch(/"nano-banana-pro"/);
    expect(EDITOR).toMatch(/setModels\(prev => \(\{ \.\.\.prev, selected: \[modelId\] \}\)\);/);
  });

  it("restores one model from drafts and undo snapshots", () => {
    expect(EDITOR).toMatch(/selected: draft\.modelsSelected\.slice\(0, 1\)/);
    expect(EDITOR).toMatch(/selected: snap\.modelsSelected\.slice\(0, 1\)/);
  });

  it("marks a refused card failed instead of leaving it generating", () => {
    expect(EDITOR.match(/\n\s+refuse\(\);\n\s+return;/g)?.length).toBe(3);
  });

  it("refuses without a model at every entry point, before anything is queued or paid", () => {
    expect(EDITOR.match(/if \(!picked\) \{\n\s+toast\(\{ title: "Pick a model"/g)?.length).toBe(5);
  });
});

/** Every .ts/.tsx under the app's source roots, tests excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("the legacy rail's client side is gone", () => {
  const LEGACY = ["hooks/useSolanaX402Payment.ts", "hooks/useX402PaymentProduction.ts", "lib/payment-confirm.ts", "app/generate/page.tsx", "app/test/page.tsx"];

  it.each(LEGACY)("%s does not exist", (f) => {
    expect(existsSync(join(ROOT, f))).toBe(false);
  });

  it("nothing imports it", () => {
    const files = ["app", "components", "hooks", "lib", "providers"].flatMap((d) => sources(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(100);
    const importers = files.filter((f) => /from "@\/(hooks\/useSolanaX402Payment|hooks\/useX402PaymentProduction|lib\/payment-confirm)"/.test(readSource(f)));
    expect(importers).toEqual([]);
  });
});
