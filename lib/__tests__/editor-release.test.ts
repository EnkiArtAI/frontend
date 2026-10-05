import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Release in the prompt editor is a save that asks for the listing (Kev,
 * 2026-10-05: the artist lists a prompt when they want, once the checks have
 * passed). It used to save only a prompt without an id and then set a publish
 * date through PATCH, which listed nothing and judged nothing.
 */
const EDITOR = readSource(join(__dirname, "..", "..", "components", "EnkiPromptEditor.tsx"));
const release = EDITOR.slice(EDITOR.indexOf("const publishPromptMutation = useMutation({"), EDITOR.indexOf("const verifiedCount ="));

describe("releasing from the prompt editor", () => {
  it("always saves what is in the editor, asking the server to list it", () => {
    expect(release).toContain("const saved = await savePromptMutation.mutateAsync({ release: true });");
    // No release without that save: an id alone no longer skips it.
    expect(release).not.toMatch(/if \(!id\) \{\s*const saved = await savePromptMutation/);
  });

  it("sends the release with the save itself", () => {
    expect(EDITOR).toContain("mutationFn: async (opts?: { release?: boolean }) => {");
    expect(EDITOR).toContain("...(opts?.release ? { release: true } : {}),");
  });

  it("no longer marks a prompt published on the side", () => {
    expect(release).not.toContain("published: true");
    expect(release).not.toContain('method: "PATCH"');
  });

  it("shows the server's reason when the release is refused", () => {
    // The save throws the server's sentence, and the release passes it on.
    expect(release).toContain('description: error instanceof Error ? error.message : "Publish failed.",');
  });
});
