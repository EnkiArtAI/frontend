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

  // A picked NFT is a link; the server never fetches one, so the browser sends its bytes.
  let signals: (AbortSignal | undefined)[] = [];
  const fetching = (answer: () => Promise<Response>) => {
    const asked: string[] = [];
    signals = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => { asked.push(u); signals.push(init?.signal ?? undefined); return answer(); }));
    return asked;
  };

  it("readReference gives a link 20 s, so a host that never answers holds nothing for good", async () => {
    vi.stubGlobal("FileReader", fakeReader("load"));
    fetching(async () => new Response(new Blob(["x"])));
    const { readReference } = await import("@/hooks/useReferenceReads");
    await readReference("https://x.test/a.png");
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(src("hooks", "useReferenceReads.ts")).toContain("fetch(src, { signal: AbortSignal.timeout(20_000) })");
  });

  it("readReference fetches a link and reads its bytes as the image", async () => {
    vi.stubGlobal("FileReader", fakeReader("load"));
    const asked = fetching(async () => new Response(new Blob(["x"])));
    const { readReference } = await import("@/hooks/useReferenceReads");
    await expect(readReference("https://arweave.net/a.png")).resolves.toBe("data:image/png;base64,AA==");
    expect(asked).toEqual(["https://arweave.net/a.png"]);
  });

  it("readReference answers null when a link fails or answers an error, so nothing waits for good", async () => {
    vi.stubGlobal("FileReader", fakeReader("load"));
    const { readReference } = await import("@/hooks/useReferenceReads");
    fetching(async () => { throw new TypeError("blocked by CORS"); });
    await expect(readReference("https://x.test/a.png")).resolves.toBeNull();
    fetching(async () => new Response("gone", { status: 404 }));
    await expect(readReference("https://x.test/a.png")).resolves.toBeNull();
    // The headers came in time, the body did not: the timeout ends the body read too.
    fetching(async () => ({ ok: true, blob: async () => { throw new DOMException("timed out", "TimeoutError"); } }) as unknown as Response);
    await expect(readReference("https://x.test/a.png")).resolves.toBeNull();
  });

  it("readReference reads a file in place and fetches nothing", async () => {
    vi.stubGlobal("FileReader", fakeReader("load"));
    const asked = fetching(async () => new Response(new Blob(["x"])));
    const { readReference } = await import("@/hooks/useReferenceReads");
    await expect(readReference(new Blob(["x"]))).resolves.toBe("data:image/png;base64,AA==");
    expect(asked).toEqual([]);
  });
});

describe("every generate surface waits for its reference images", () => {
  it("reads them through the shared counter, never a bare FileReader", () => {
    for (const s of [LAUNCHER, BUYER, EDITOR, EDITOR2]) {
      expect(s).toMatch(/const \{ loading: refsLoading, (pending: refsPending, )?read: readRef \} = useReferenceReads\(\);/);
      expect(s).not.toMatch(/new FileReader\(\)[\s\S]{0,200}readAsDataURL/);
    }
  });

  it("quick create refuses and greys Generate while they load", () => {
    expect(LAUNCHER).toMatch(/if \(generating\) return;\n\s+if \(refsLoading\) \{/);
    expect(LAUNCHER).toMatch(/generateBlocked=\{refsLoading\}/);
    // A picked NFT waits the same way, and travels as the image itself.
    expect(LAUNCHER).toContain("onPick={addNfts}");
    expect(LAUNCHER).toContain("urls.forEach((u) => void readRef(u).then((img) => {");
  });

  it("quick create holds a picked NFT to the model's file types and limit, as an upload", () => {
    const add = LAUNCHER.slice(LAUNCHER.indexOf("const addNfts = (urls: string[]) => {"), LAUNCHER.indexOf("const reorder = "));
    expect(add).toContain('const type = /^data:([^;,]*)/i.exec(img)?.[1].toLowerCase() ?? "";');
    expect(add).toMatch(/if \(modelLimits\.filetypes\.length && !modelLimits\.filetypes\.includes\(type\)\) \{\n\s+toast\(\{ title: "File type not supported"[^\n]*\n\s+return;/);
    expect(add).toMatch(/if \(prev\.length \+ referenceImages\.length >= modelLimits\.maxRefs\) \{\n\s+toast\(\{ title: "Reference limit reached"[^\n]*\n\s+return prev;/);
    expect(add).toContain("return [...prev, img];");
  });

  it("quick create drops a read that ends after another prompt opened", () => {
    const seed = LAUNCHER.slice(LAUNCHER.indexOf("setLocked(isPaid);"), LAUNCHER.indexOf("}, [seedPrompt]);"));
    expect(seed).toContain("refsEpoch.current++;");
    expect(LAUNCHER).toMatch(/const addNfts = \(urls: string\[\]\) => \{\n\s+const epoch = refsEpoch\.current;\n\s+urls\.forEach\(\(u\) => void readRef\(u\)\.then\(\(img\) => \{\n\s+if \(epoch !== refsEpoch\.current\) return;/);
    expect(LAUNCHER).toMatch(/const epoch = refsEpoch\.current;\n\s+void readRef\(file\)\.then\(\(url\) => \{\n\s+if \(url && epoch === refsEpoch\.current\) \{/);
  });

  it("quick create's Generate is greyed by the modal while they load", () => {
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

describe("an image still being read shows greyed, and only there", () => {
  const HOOK = src("hooks", "useReferenceReads.ts");

  it("gets a preview before the read and loses it after, whatever the read answered", () => {
    // A link is previewed by its own address, which is never revoked.
    // A link's preview is its address made unique, so two reads of one address each hold Generate.
    const added = HOOK.search(/const preview = typeof file === "string" \? `\$\{file\}#read-\$\{\+\+linkReads\}` : URL\.createObjectURL\(file\);\s+setPending\(\(p\) => \[\.\.\.p, preview\]\);/);
    const read = HOOK.search(/return await readReference\(file\);/);
    const gone = HOOK.search(/\} finally \{\s+setPending\(\(p\) => p\.filter\(\(u\) => u !== preview\)\);\s+if \(typeof file !== "string"\) URL\.revokeObjectURL\(preview\);/);
    expect(added).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(added);
    expect(gone).toBeGreaterThan(read);
    expect(HOOK).toMatch(/return \{ loading: pending\.length > 0, pending, read \};/);
  });

  it("every reference strip renders the previews greyed after its images", () => {
    const greyed = /\{refsPending\.map\(\(src\) => \(\s+<div key=\{src\} className="[a-z-]+ enki-ref-pending"/;
    expect(BUYER).toMatch(greyed);
    expect(EDITOR).toMatch(greyed);
    expect(MODAL).toMatch(/\{pendingReferenceImages\.map\(\(src\) => \(\s+<div key=\{src\} className="mobile-modal-ref-thumb enki-ref-pending"/);
    expect(LAUNCHER).toMatch(/pendingReferenceImages=\{refsPending\}/);
    expect(src("app", "globals.css")).toMatch(/\.enki-ref-pending \{ opacity: 0\.45; filter: grayscale\(1\); pointer-events: none; \}/);
  });

  it("a preview never enters a reference list, so no draft or generation carries one", () => {
    for (const [name, code] of [["buyer", BUYER], ["editor", EDITOR], ["launcher", LAUNCHER]] as const) {
      const uses = code.match(/refsPending/g) ?? [];
      const rendered = code.match(/refsPending\.(map|length)|=\{refsPending\}|pending: refsPending/g) ?? [];
      expect(uses.length, name).toBe(rendered.length);
    }
  });
});
