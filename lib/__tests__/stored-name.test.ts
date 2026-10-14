import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { storedName } from "@/lib/generation/stored-name";
import { storedName as fromPromptText } from "@/lib/generation/prompt-text";

/**
 * The editor warns when two [slots] would be saved under one name, so it
 * needs the server's naming rule in the browser. stored-name.ts is that rule
 * with no imports; prompt-text.ts (which decrypts) re-exports it.
 */
describe("storedName", () => {
  it("names slots that differ only in case or punctuation alike", () => {
    expect(storedName("Cat")).toBe("cat");
    expect(storedName("cat")).toBe("cat");
    expect(storedName("red car")).toBe("red_car");
    expect(storedName("red-car")).toBe("red_car");
  });

  it("puts v_ in front of a name that does not start with a letter", () => {
    expect(storedName("2nd")).toBe("v_2nd");
    expect(storedName("_x")).toBe("x");
  });

  it("is null when no ASCII letter or digit survives", () => {
    expect(storedName("名前")).toBeNull();
    expect(storedName("--")).toBeNull();
  });

  it("is the same function prompt-text exports, in a file with no imports", () => {
    expect(fromPromptText).toBe(storedName);
    const src = readSource(join(__dirname, "..", "generation", "stored-name.ts"));
    expect(src).not.toMatch(/^\s*import\b/m);
  });
});
