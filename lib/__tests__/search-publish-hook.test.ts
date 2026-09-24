import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The publish route is the one place the prompt body exists in the clear on
 * the server, so it is the one place search tags may be computed from it.
 * These scans hold that boundary: the matcher reads body.content (plaintext)
 * with the paid rules, the merged result is what lands in prompts.tags, and
 * nothing else about the body leaves the request.
 */

const ROUTE = join(__dirname, "..", "..", "app", "api", "prompt", "route.ts");
const src = readSource(ROUTE);

function promptRowBlock(): string {
  const m = src.match(/const promptRow = \{([\s\S]*?)\n\s*\};/);
  expect(m, "promptRow literal not found").not.toBeNull();
  return m![1];
}

describe("/api/prompt computes search tags at publish", () => {
  it("uses the vocabulary matcher from lib/search/tags", () => {
    expect(src).toMatch(/import \{ extractTags, mergeTags \} from "@\/lib\/search\/tags"/);
  });

  it("writes the merged tags, with the creator's own tags first", () => {
    expect(promptRowBlock()).toMatch(/^\s*tags: searchTags,/m);
    expect(src).toMatch(/mergeTags\(tags, \[/);
  });

  it("matches the plaintext body with the paid rules, never the ciphertext", () => {
    expect(src).toMatch(/extractTags\(body\.content, \{\s*paid: \(PROMPT_TYPE_TO_DB\[clientPromptType\] \?\? clientPromptType\) === "paid",/);
    expect(src).not.toMatch(/extractTags\(enc\b/);
    expect(src).not.toMatch(/extractTags\([^)]*encrypted/);
  });

  it("matches the title and the variables' names, labels, defaults and option values", () => {
    expect(src).toMatch(/extractTags\(`\$\{body\.title\}\\n\$\{variableText\}`\)/);
    expect(src).toMatch(/v\.name,\s*v\.label,\s*v\.defaultValue,/);
    expect(src).toMatch(/o\.visibleName, o\.label, o\.promptValue/);
  });
});
