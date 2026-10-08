import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { placeholderArt } from "@/components/enki-shell/generation";

/**
 * Mock-up mode fills outputs with the editor's own SVG placeholder art. The
 * library's image check refuses an SVG (it may animate), so such a workflow
 * could never be saved: the editor leaves the art out and the output empty.
 */

const EDITOR = readSource(join(__dirname, "..", "..", "components", "enki-shell", "NodeCreator.tsx"));

describe("saving a mock-up workflow to the library", () => {
  it("leaves the placeholder art out, by the prefix the art is made with", () => {
    expect(placeholderArt("seed", "1:1").startsWith("data:image/svg+xml")).toBe(true);
    const save = EDITOR.slice(EDITOR.indexOf("const saveToLibrary = async () => {"), EDITOR.indexOf("onToast(res.ok ? `Saved"));
    expect(save).toContain('graph.nodes = graph.nodes.map((n) => (typeof n.image === "string" && n.image.startsWith("data:image/svg+xml") ? { ...n, image: undefined, status: "empty" } : n));');
    expect(save).toContain('body: JSON.stringify({ name, kind: "workflow", graph, promptText: stRef.current.body }),');
  });
});
