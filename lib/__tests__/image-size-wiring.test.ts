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

  it("is no save without the prompt it answers with, whatever the status", () => {
    expect(EDITOR).toMatch(/await response\.json\(\)\.catch\(\(\) => null\);\n\s+if \(!response\.ok \|\| !savedPrompt\) \{/);
  });
});

describe("an upload", () => {
  it("to the gallery is made smaller until it arrives, and the fitted file is sent", () => {
    const zone = src("components", "ShowroomUploadZone.tsx");
    expect(zone).toMatch(/const file = await fitUpload\(upload\.file\);\n\s+if \(!file\) throw new Error\(`\$\{upload\.file\.name\} could not be read or made small enough to upload\.`\);\n\s+const formData = new FormData\(\);\n\s+formData\.append\('file', file\);/);
    expect(zone).not.toContain("formData.append('file', upload.file)");
  });

  it("to the gallery that fails says why", () => {
    expect(src("components", "ShowroomUploadZone.tsx")).toContain("description: results.find((r) => !r.success)?.error ??");
  });

  it("in a message is made smaller until it arrives, and the fitted file is sent", () => {
    const panel = src("components", "enki-shell", "MessagesPanel.tsx");
    expect(panel).toMatch(/const fit = await fitUpload\(f\);\n\s+if \(!fit\) \{ toast\?\.\(`\$\{f\.name\} could not be read or made small enough to send\.`\); continue; \}/);
    expect(panel).toContain('fd.append("file", fit);');
    expect(panel).not.toContain('fd.append("file", f);');
  });

  it("of a profile picture or cover is labelled as what the browser encoded", () => {
    const profile = src("components", "profile", "ProfileView.tsx");
    expect(profile).toContain("const blob = await encodeCanvas(canvas, 0.85);");
    expect(profile).toContain('return blob ? new File([blob], `image.${blob.type.split("/")[1]}`, { type: blob.type }) : null;');
  });
});
