import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { nameSlotByItsText } from "@/lib/editor/slot-name";

/**
 * The mobile sheet is the whole editor on a phone, and a release sends what
 * it holds. A slot written there could not be given the name a save needs.
 */
const EDITOR = readSource(join(__dirname, "..", "..", "..", "components", "EnkiPromptEditor.tsx"));

describe("a slot written on a phone", () => {
  const slot = (name: string, fullToken: string) => ({ id: "v1", name, fullToken, defaultValue: "a tabby" });

  it("is named by its own text, which is the token standing in the prompt", () => {
    expect(nameSlotByItsText(slot("", "[cat]"), true)).toEqual({ id: "v1", name: "cat", fullToken: "[cat]", defaultValue: "a tabby" });
    expect(nameSlotByItsText(slot("  ", "[red car]"), true).name).toBe("red car");
    // The token is matched as written when the image is generated, spaces included.
    expect(nameSlotByItsText(slot("", "[ cat ]"), true).name).toBe(" cat ");
  });

  it("keeps a name its artist gave it", () => {
    const named = slot("animal", "[animal]");
    expect(nameSlotByItsText(named, true)).toBe(named);
  });

  it("stays unnamed on a desktop, where the artist names it in the editor", () => {
    const unnamed = slot("", "[cat]");
    expect(nameSlotByItsText(unnamed, false)).toBe(unnamed);
  });

  it("is named where the editor finds slots, for a slot it already knew and for a new one", () => {
    const sync = EDITOR.slice(EDITOR.indexOf("const detectionByToken = new Map("), EDITOR.indexOf("variableLabelRegistryRef.current = buildLabelRegistry("));
    expect(sync).toContain("merged.push(normalizeVariable(nameSlotByItsText(existing, isMobileViewport), merged));");
    expect(sync).toContain("merged.push(normalizeVariable(nameSlotByItsText(draft, isMobileViewport), merged));");
    // Again when the window becomes a phone's: slots written on a desktop and left unnamed.
    expect(sync).toContain("}, [promptData.body, isMobileViewport]);");
  });
});
