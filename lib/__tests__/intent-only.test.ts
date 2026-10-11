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

describe("the current editor uses the shared generation queue", () => {
  it("queues a checked artist request", () => {
    const editor = src("components", "prompt-editor", "PromptEditor.tsx");
    expect(editor).toContain('toRequest: (s) => editorRequest(s, catalogue, readyRefs(state.refs, s.refIds) ?? []),');
    expect(editor).toContain('if (block || !entry) {');
    expect(editor).not.toMatch(/useSolanaX402Payment|useX402PaymentProduction|\/api\/generate-free/);
  });
  it("starts without a preselected generator", () => {
    expect(src("components", "prompt-editor", "usePromptEditor.ts")).toContain('primaryId: null, testId: null');
  });
});
