import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Where a surface sends images, the size rules must be wired in. These are
 * React components that cannot run in node, so their wiring is pinned; what
 * the wired functions do is tested in shrink-image and request-size.
 */
const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readSource(join(ROOT, ...p));

describe("the prompt editor's save", () => {
  const EDITOR = src("components", "EnkiPromptEditor.tsx");

  it("is refused before it is sent when it is too large to arrive", () => {
    expect(EDITOR).toMatch(/if \(tooLargeToSend\(payload\)\) throw new Error\(SAVE_TOO_LARGE\);\n\s+const response = await fetch\("\/api\/prompt", \{/);
  });

  it("reads an answer that is not JSON as a failed save, not a parse error", () => {
    expect(EDITOR).toContain("const savedPrompt: unknown = await response.json().catch(() => null);");
  });
});
