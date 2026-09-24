import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { isFreePrompt } from "../prompt-visibility";

/**
 * The publish route is the one place the prompt body exists in the clear on
 * the server, so it is the one place search tags may be computed from it.
 * These scans hold that boundary: the matcher reads body.content (plaintext)
 * with the paid rules, the merged result is what lands in prompts.tags, and
 * nothing else about the body leaves the request.
 */

const ROUTE = join(__dirname, "..", "..", "app", "api", "prompt", "route.ts");
const src = readSource(ROUTE);
const viewRoute = readSource(join(__dirname, "..", "..", "app", "api", "prompts", "[id]", "route.ts"));

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

  it("matches the plaintext body with the paid rules whenever the body is hidden, never the ciphertext", () => {
    // Not === "paid": a create-now prompt (the default) is charged and its
    // body hidden, so its body must be matched with the paid rules too.
    expect(src).toMatch(/extractTags\(body\.content, \{\s*paid: !isFreePrompt\(\{ prompt_type: dbPromptType, is_free_showcase: isFreeShowcase \}\),/);
    expect(src).toMatch(/const dbPromptType = PROMPT_TYPE_TO_DB\[clientPromptType\] \?\? clientPromptType;/);
    expect(src).toMatch(/^\s*prompt_type: dbPromptType,/m);
    expect(src).not.toMatch(/=== "paid"/);
    expect(src).not.toMatch(/extractTags\(enc\b/);
    expect(src).not.toMatch(/extractTags\([^)]*encrypted/);
  });

  it("the publish hook and the viewer route hide by the same predicate", () => {
    for (const s of [src, viewRoute]) expect(s).toMatch(/import \{ isFreePrompt \} from "@\/lib\/prompt-visibility"/);
    expect(viewRoute).toMatch(/const isFree = isFreePrompt\(\{ prompt_type: dbPromptType, is_free_showcase: prompt\.is_free_showcase === true \}\);/);
    expect(viewRoute).not.toMatch(/dbPromptType === "showcase"/);
  });

  it("isFreePrompt shows only showcase, free and free showcases in the clear", () => {
    expect(isFreePrompt({ prompt_type: "showcase" })).toBe(true);
    expect(isFreePrompt({ prompt_type: "free" })).toBe(true);
    expect(isFreePrompt({ prompt_type: "paid", is_free_showcase: true })).toBe(true);
    expect(isFreePrompt({ prompt_type: "paid", is_free_showcase: false })).toBe(false);
    expect(isFreePrompt({ prompt_type: "create-now" })).toBe(false);
    expect(isFreePrompt({ prompt_type: "create-now", is_free_showcase: null })).toBe(false);
  });

  it("matches the title and the variables' names, labels, defaults and option values", () => {
    expect(src).toMatch(/extractTags\(`\$\{body\.title\}\\n\$\{variableText\}`\)/);
    expect(src).toMatch(/v\.name,\s*v\.label,\s*v\.defaultValue,/);
    expect(src).toMatch(/o\.visibleName, o\.label, o\.promptValue/);
  });
});
