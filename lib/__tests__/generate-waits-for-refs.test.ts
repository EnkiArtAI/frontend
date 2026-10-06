import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Reference images are read in the browser before they can travel with a
 * generation. A Generate click while one was still being read paid for a
 * picture that never saw it (Kev, 2026-10-06: block generating while
 * reference images are still loading).
 */

const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readSource(join(ROOT, ...p));
const LAUNCHER = src("components", "GenerateLauncher.tsx");
const MODAL = src("components", "EnkiMobileGenerateModal.tsx");
const BUYER = src("components", "PromptGeneratorView.tsx");
const EDITOR = src("components", "EnkiPromptEditor.tsx");
const EDITOR2 = src("components", "enki-shell", "NodeCreator.tsx");

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("readImageFile", () => {
  function fakeReader(outcome: "load" | "error") {
    return class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        queueMicrotask(() => {
          if (outcome === "load") { this.result = "data:image/png;base64,AA=="; this.onload?.(); }
          else this.onerror?.();
        });
      }
    };
  }

  it("answers the data URL", async () => {
    vi.stubGlobal("FileReader", fakeReader("load"));
    const { readImageFile } = await import("@/hooks/useReferenceReads");
    await expect(readImageFile(new Blob(["x"]))).resolves.toBe("data:image/png;base64,AA==");
  });

  it("answers null on a read error, so Generate is never blocked for good", async () => {
    vi.stubGlobal("FileReader", fakeReader("error"));
    const { readImageFile } = await import("@/hooks/useReferenceReads");
    await expect(readImageFile(new Blob(["x"]))).resolves.toBeNull();
  });
});

describe("every generate surface waits for its reference images", () => {
  it("reads them through the shared counter, never a bare FileReader", () => {
    for (const s of [LAUNCHER, BUYER, EDITOR, EDITOR2]) {
      expect(s).toMatch(/const \{ loading: refsLoading, read: readRef \} = useReferenceReads\(\);/);
      expect(s).not.toMatch(/new FileReader\(\)[\s\S]{0,200}readAsDataURL/);
    }
  });

  it("quick create refuses and greys Generate while they load", () => {
    expect(LAUNCHER).toMatch(/if \(generating\) return;\n\s+if \(refsLoading\) \{/);
    expect(LAUNCHER).toMatch(/generateBlocked=\{refsLoading\}/);
    expect(MODAL).toMatch(/onClick=\{\(\) => onGenerate\(genCountNum\)\} disabled=\{isGenerating \|\| generateBlocked\}/);
  });

  it("the buyer page refuses and greys Generate while they load", () => {
    expect(BUYER).toMatch(/const generate = useCallback\(async \(\) => \{\n\s+if \(refsLoading\) \{/);
    expect(BUYER).toMatch(/disabled=\{generating \|\| refsLoading \|\| guest/);
  });

  it("the classic editor refuses on every generate path while they load", () => {
    expect(EDITOR).toMatch(/const handlePayAndGenerate = \(\) => \{\n\s+if \(refsStillLoading\(\)\) return;/);
    expect(EDITOR).toMatch(/const handleRefillAndGenerate = \(\) => \{\n\s+if \(ui\.selectedCards\.length === 0\) return;\n\s+if \(refsStillLoading\(\)\) return;/);
    expect(EDITOR).toMatch(/onGenerate=\{\(count\) => \{\n\s+if \(refsStillLoading\(\)\) return;/);
    expect(EDITOR).toMatch(/generateBlocked=\{refsLoading\}/);
  });

  it("Editor 2 refuses on both generate paths while they load", () => {
    expect(EDITOR2.split("if (refsLoading) { onToast(REFS_LOADING); return; }").length - 1).toBe(2);
    expect(EDITOR2).toMatch(/return Promise\.all\(files\.map\(readRef\)\)/);
  });
});
