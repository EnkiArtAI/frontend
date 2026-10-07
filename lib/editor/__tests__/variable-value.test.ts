import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { fixedValue, snapshotValue } from "@/lib/editor/variable-value";

/**
 * Verify cards stored "off" for an unticked checkbox, "on" for a ticked one
 * without text and "true" or the variable's name on three other paths, and
 * the generation put those words into the paid prompt (Kev, 2026-10-06).
 */

const box = (on: boolean, description = "") => ({ name: "glow", type: "checkbox", defaultValue: on, description });

describe("snapshotValue", () => {
  it("adds nothing for an unticked checkbox", () => {
    expect(snapshotValue(box(false, "soft glow"))).toBe("");
    expect(snapshotValue(box(false))).toBe("");
  });

  it("adds a ticked checkbox's text, and nothing when it has none", () => {
    expect(snapshotValue(box(true, "soft glow"))).toBe("soft glow");
    expect(snapshotValue(box(true))).toBe("");
  });

  it("adds an image variable's description", () => {
    expect(snapshotValue({ name: "ref", type: "image", defaultValue: "", description: "the red chair" })).toBe("the red chair");
  });

  it("keeps a text variable's value, or its name while it has none", () => {
    expect(snapshotValue({ name: "subject", type: "text", defaultValue: "a fox", description: "" })).toBe("a fox");
    expect(snapshotValue({ name: "subject", type: "text", defaultValue: "", description: "" })).toBe("subject");
    expect(fixedValue({ name: "subject", type: "text", defaultValue: "a fox", description: "" })).toBeNull();
  });
});

describe("the classic editor", () => {
  const EDITOR = readSource(join(__dirname, "..", "..", "..", "components", "EnkiPromptEditor.tsx"));

  it("never stores on, off or a raw default as a card value", () => {
    expect(EDITOR).not.toMatch(/\? v\.description \|\| "on" : "off"/);
    expect(EDITOR).not.toMatch(/snapshot\[v\.name\] = \(v\.defaultValue as string\) \|\| v\.name/);
    expect(EDITOR).not.toMatch(/baseSnapshot\[v\.name\] = \(v\.defaultValue as string\) \|\| v\.name/);
  });

  it("builds every card value with the shared rule", () => {
    expect(EDITOR.split("snapshotValue(v)").length - 1).toBe(4);
    expect(EDITOR).toMatch(/const fixed = fixedValue\(v\);/);
    expect(EDITOR).toMatch(/snapshot\[variable\.name\] \?\? fixedValue\(variable\) \?\? \(\(variable\.defaultValue as string\) \|\| ""\)/);
  });
});
