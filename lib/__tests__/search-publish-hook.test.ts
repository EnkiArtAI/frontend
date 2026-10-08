import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The publish route is the one place the prompt body exists in the clear on
 * the server, so it is the one place search tags may be computed from it.
 * These scans hold that boundary: the matcher reads body.content (plaintext)
 * with the paid rules, our tags alone land in prompts.tags (a creator sends
 * none, Kev 2026-10-07), and nothing else about the body leaves the request.
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
    expect(src).toMatch(/import \{ extractTags, storedTags \} from "@\/lib\/search\/tags"/);
  });

  it("writes only the tags it computed, never the client's", () => {
    expect(promptRowBlock()).toMatch(/^\s*tags: searchTags,/m);
    // The body's tags first: they outrank title and options at the cap.
    expect(src).toMatch(/const searchTags = storedTags\(\n\s+extractTags\(body\.content, \{ paid: !publicText \}\),\n\s+extractTags\(`\$\{body\.title\}\\n\$\{variableText\}`\),\n\s+\);/);
    expect(src).not.toMatch(/body\.tags/);
  });

  it("matches the plaintext body with the paid rules whenever the body is hidden, never the ciphertext", () => {
    // Not === "paid": a create-now prompt (the default) is charged and its
    // body hidden, so its body must be matched with the paid rules too.
    expect(src).toMatch(/extractTags\(body\.content, \{ paid: !publicText \}\)/);
    expect(src).toMatch(/const publicText = isPublicText\(\{ prompt_type: dbPromptType, is_free_showcase: isFreeShowcase \}\);/);
    expect(src).toMatch(/^\s*prompt_type: dbPromptType,/m);
    expect(src).not.toMatch(/=== "paid"/);
    expect(src).not.toMatch(/extractTags\(enc\b/);
    expect(src).not.toMatch(/extractTags\([^)]*encrypted/);
  });

  it("the publish hook and the viewer route hide by the same predicate", () => {
    for (const s of [src, viewRoute]) expect(s).toMatch(/import \{[^}]*\bisPublicText\b[^}]*\} from "@\/lib\/prompt-visibility"/);
    // An unlisted prompt reaches the text only for its creator: the route answers 404 to anyone else first.
    expect(viewRoute).toContain("(!isListed(prompt) && !isOwner) ||");
    expect(viewRoute).toMatch(/if \(isPublicText\(prompt\)\) \{/);
    expect(viewRoute).not.toMatch(/dbPromptType === "showcase"/);
  });

  it("matches the title and the variables' names, labels, defaults and option values", () => {
    expect(src).toMatch(/extractTags\(`\$\{body\.title\}\\n\$\{variableText\}`\)/);
    expect(src).toMatch(/v\.name,\s*v\.label,\s*v\.defaultValue,/);
    expect(src).toMatch(/o\.visibleName, o\.label, o\.promptValue/);
  });
});
