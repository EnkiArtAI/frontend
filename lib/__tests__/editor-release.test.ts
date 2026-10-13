import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { readSource } from "@/lib/__tests__/_read-source";
const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readSource(join(ROOT, ...p));
const EDITOR = src("components", "prompt-editor", "PromptEditor.tsx");
// Body and guard behavior is covered by lib/editor/__tests__/release.test.ts.
describe("release from the current prompt editor", () => {
  it("sends a checked body by POST and keeps the editor on its returned id", () => {
    expect(EDITOR).toContain('fetch("/api/prompt", {');
    expect(EDITOR).toContain('method: "POST"');
    expect(EDITOR).toContain('body: JSON.stringify(body),');
    expect(EDITOR).toContain('if ("error" in made) return notify(made.error, { tone: "error" });');
    expect(EDITOR).toContain('if (!body.id) {');
    expect(EDITOR).toContain('router.replace(');
    expect(EDITOR).toContain('/editor?id=');
    expect(EDITOR).not.toContain('published: true');
  });
  it("does not mark a refused or malformed answer as released", () => {
    const refused = EDITOR.slice(EDITOR.indexOf('if (!res.ok || !data.id) {'), EDITOR.indexOf('dispatch({ type: "released"'));
    expect(refused).toContain('const why = data.error ?? "Release failed — nothing was published";');
    expect(refused).toContain('return;');
    expect(EDITOR).toContain('marked 18+, shown only to viewers who may see 18+');
  });
  it("uses the current whole-cent price contract", () => {
    expect(src("components", "prompt-editor", "usePromptEditor.ts")).toContain('price: DEFAULT_PROMPT_PRICE_USD');
    const price = src("components", "prompt-editor", "PriceStepper.tsx");
    expect(price).toContain('stepPrice(price, -1)');
    expect(price).toContain('stepPrice(price, 1)');
    expect(price).toContain('const cents = Math.round(price * 100) / 100;');
    // An arrow press rolls only the digits that changed (changedDigits), unless the reader asked for no motion.
    expect(price).toContain('if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;');
    expect(price).toContain('for (const i of changedDigits(p.from, shown)) digits.current[i]?.animate(rollKeyframes(p.direction), ROLL_TIMING);');
    expect(price).toContain('onClick={() => press(down, -1)}');
    expect(price).toContain('onClick={() => press(up, 1)}');
    // The digits are drawn over the input only while it is not typed in; typing sees the input itself.
    expect(price).toContain('{text === null && (\n            <span className="pe-price-digits" aria-hidden>');
    expect(src("components", "prompt-editor", "prompt-editor.css")).toContain(".pe-price-field:not([data-typing]) input { color: transparent; }");
  });
});
describe("the retained Quick Create sheet", () => {
  const sheet = src("components", "EnkiMobileGenerateModal.tsx");
  it("never substitutes generation for an unwired release button", () => {
    const button = sheet.slice(sheet.lastIndexOf("<button", sheet.indexOf("Release prompt")), sheet.indexOf("Release prompt"));
    expect(button).toContain('onClick={onRelease}');
    expect(button).toContain('disabled={!releaseReady || !onRelease}');
    expect(button).not.toContain('onGenerate');
  });
  it("keeps parent settings when supplied and otherwise uses its own", () => {
    for (const field of ['const titleVal = title ?? localTitle;', 'const typeVal = promptType ?? localType;', 'const priceVal = price ?? localPrice;']) expect(sheet).toContain(field);
    expect(sheet).toContain('const prefModels = onToggleModel ? models.selected : internalPrefModels;');
  });
});


it("refreshes fresh cached Home variants and creator shelves after a successful release", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
  const listings = [
    ["/api/marketplace/prompts", "home", "", "safe", ""],
    ["/api/marketplace/prompts", "home", "flux", "18+", "portrait"],
    ["/api/marketplace/prompts", "profile", "creator-a"],
    ["/api/marketplace/prompts", "profile", "creator-b"],
  ];
  for (const key of listings) client.setQueryData(key, { pages: [{ prompts: [{ id: "old" }] }], pageParams: [1] });
  client.setQueryData(["bookmark-index", "creator-a"], new Map());
  const success = EDITOR.slice(EDITOR.indexOf('dispatch({ type: "released"'), EDITOR.indexOf('if (!body.id) {'));
  const prefixes = [...success.matchAll(/queryClient\.invalidateQueries\(\{ queryKey: \["([^"]+)"/g)].map(match => match[1]);
  for (const prefix of prefixes) await client.invalidateQueries({ queryKey: [prefix] });
  for (const key of listings) expect(client.getQueryState(key)?.isInvalidated, key.join(" / ")).toBe(true);
  expect(client.getQueryState(["bookmark-index", "creator-a"])?.isInvalidated).toBe(false);
  client.clear();
});
