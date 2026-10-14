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

  it("to a feedback report is a still image made smaller before it counts, a GIF or video as it is", () => {
    const modal = src("components", "enki-shell", "FeedbackModal.tsx");
    expect(modal).toContain('const STILLS = ["image/png", "image/jpeg", "image/webp"];');
    expect(modal).toContain("const picked = await Promise.all(Array.from(list).map(async (f) => (STILLS.includes(f.type) ? ((await fitUpload(f)) ?? f) : f)));");
    expect(modal).toContain("const { files: next, refused } = addFeedbackFiles(files, picked);");
    // Nothing changes the list while it is being redrawn, and nothing is sent half-attached.
    expect(modal).toMatch(/setAttaching\(true\);\n\s+try \{[\s\S]+\} finally \{\n\s+setAttaching\(false\);/);
    expect(modal).toContain("const canSend = !!sev && text.trim().length >= 10 && !busy && !attaching;");
    expect(modal.match(/disabled=\{attaching\}/g)).toHaveLength(2);
  });
});

describe("the current editor's release", () => {
  const EDITOR = src("components", "prompt-editor", "PromptEditor.tsx");
  const BODY = src("lib", "editor", "release.ts");
  it("refuses an oversized body before sending it", () => {
    expect(BODY).toContain('return tooLargeToSend(body) ? { error: SAVE_TOO_LARGE } : { body, refIds: cover.refIds };');
    expect(EDITOR).toContain('if ("error" in made) return notify(made.error, { tone: "error" });');
    expect(EDITOR.indexOf('if ("error" in made)')).toBeLessThan(EDITOR.indexOf('void send(made);'));
  });
  it("reads a non-JSON answer as a failed release rather than a parse error", () => {
    expect(EDITOR).toContain('await res.json().catch(() => ({}))');
  });
  it("requires a successful status and a prompt id before recording release", () => {
    expect(EDITOR).toContain('if (!res.ok || !data.id) {');
    expect(EDITOR.indexOf('if (!res.ok || !data.id)')).toBeLessThan(EDITOR.indexOf('dispatch({ type: "released"'));
  });
});
