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

  // A picked NFT is read through our own route, never from its host (app/api/wallet/nfts/image).
  const PICK = { image: "https://arweave.net/a.png", thumb: "https://cdn.helius-rpc.com/cdn-cgi/image/tile/https://arweave.net/a.png" };
  let inits: (RequestInit | undefined)[] = [];
  const fetching = (answer: () => Promise<Response>) => {
    const asked: string[] = [];
    inits = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => { asked.push(u); inits.push(init); return answer(); }));
    return asked;
  };
  // The session the route asks for, as the browser keeps it.
  const signedIn = () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "enki_session_token" ? "tok" : null) });
  };

  it("readReference reads a picked NFT through our own route, with the session, 20 s at most", async () => {
    vi.stubGlobal("FileReader", fakeReader("load"));
    signedIn();
    const asked = fetching(async () => new Response(new Blob(["x"])));
    const { readReference } = await import("@/hooks/useReferenceReads");
    await expect(readReference(PICK)).resolves.toBe("data:image/png;base64,AA==");
    expect(asked).toEqual([`/api/wallet/nfts/image?src=${encodeURIComponent(PICK.image)}`]);
    expect(inits[0]?.headers).toEqual({ "X-Session-Token": "tok" });
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(src("hooks", "useReferenceReads.ts")).toContain("signal: AbortSignal.timeout(20_000),");
  });

  it("readReference answers null when a pick fails or answers an error, so nothing waits for good", async () => {
    vi.stubGlobal("FileReader", fakeReader("load"));
    signedIn();
    const { readReference } = await import("@/hooks/useReferenceReads");
    fetching(async () => { throw new TypeError("network"); });
    await expect(readReference(PICK)).resolves.toBeNull();
    fetching(async () => new Response("gone", { status: 502 }));
    await expect(readReference(PICK)).resolves.toBeNull();
    // The headers came in time, the body did not: the timeout ends the body read too.
    fetching(async () => ({ ok: true, blob: async () => { throw new DOMException("timed out", "TimeoutError"); } }) as unknown as Response);
    await expect(readReference(PICK)).resolves.toBeNull();
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
    for (const s of [LAUNCHER]) {
      expect(s).toMatch(/const \{ loading: refsLoading, (pending: refsPending, )?read: readRef \} = useReferenceReads\(\);/);
      expect(s).not.toMatch(/new FileReader\(\)[\s\S]{0,200}readAsDataURL/);
    }
  });

  it("quick create refuses and greys Generate while they load", () => {
    const click = LAUNCHER.slice(LAUNCHER.indexOf("const generate = async (count: number) => {"), LAUNCHER.indexOf("const confirmMixedOrder"));
    expect(click).toContain("if (refsLoading) return toast(");
    expect(click.indexOf("if (refsLoading)")).toBeLessThan(click.indexOf("const base: GenerationRequest"));
    expect(click.indexOf("if (refsLoading)")).toBeLessThan(click.indexOf("await executeOrder("));
    expect(LAUNCHER).toMatch(/generateBlocked=\{refsLoading \|\|/);
    // A picked NFT waits the same way, and travels as the image itself.
    expect(LAUNCHER).toContain("onPick={addNfts}");
    expect(LAUNCHER).toContain("picks.forEach((p) => void readRef(p).then((img) => {");
  });

  it("quick create holds a picked NFT to the model's file types and limit, as an upload", () => {
    const add = LAUNCHER.slice(LAUNCHER.indexOf("const addNfts = (picks: NftPick[]) => {"), LAUNCHER.indexOf("const reorder = "));
    expect(add).toContain('const type = /^data:([^;,]*)/i.exec(img)?.[1].toLowerCase() ?? "";');
    expect(add).toMatch(/if \(modelLimits\.filetypes\.length && !modelLimits\.filetypes\.includes\(type\)\) \{\n\s+toast\(\{ title: "File type not supported"[^\n]*\n\s+return;/);
    expect(add).toMatch(/if \(prev\.length \+ referenceImages\.length >= modelLimits\.maxRefs\) \{\n\s+toast\(\{ title: "Reference limit reached"[^\n]*\n\s+return prev;/);
    expect(add).toContain("return [...prev, img];");
  });

  it("quick create drops a read that ends after another prompt opened", () => {
    const seed = LAUNCHER.slice(LAUNCHER.indexOf("setLocked(isPaid);"), LAUNCHER.indexOf("}, [seedPrompt]);"));
    expect(seed).toContain("refsEpoch.current++;");
    expect(LAUNCHER).toMatch(/const addNfts = \(picks: NftPick\[\]\) => \{\n\s+const epoch = refsEpoch\.current;\n\s+picks\.forEach\(\(p\) => void readRef\(p\)\.then\(\(img\) => \{\n\s+if \(epoch !== refsEpoch\.current\) return;/);
    expect(LAUNCHER).toMatch(/const epoch = refsEpoch\.current;\n\s+void readRef\(file\)\.then\(\(url\) => \{\n\s+if \(url && epoch === refsEpoch\.current\) \{/);
  });

  it("quick create's Generate is greyed by the modal while they load", () => {
    expect(MODAL).toMatch(/onClick=\{\(\) => onGenerate\(genCountNum\)\} disabled=\{isGenerating \|\| generateBlocked\}/);
  });
});

describe("an image still being read shows greyed, and only there", () => {
  const HOOK = src("hooks", "useReferenceReads.ts");

  it("gets a preview before the read and loses it after, whatever the read answered", () => {
    // An NFT is previewed by its tile made unique, so two reads of one tile each hold Generate;
    // a tile is no blob: URL and is never revoked.
    const added = HOOK.search(/const preview = file instanceof Blob \? URL\.createObjectURL\(file\) : `\$\{file\.thumb\}#read-\$\{\+\+nftReads\}`;\s+setPending\(\(p\) => \[\.\.\.p, preview\]\);/);
    const read = HOOK.search(/return await readReference\(file\);/);
    const gone = HOOK.search(/\} finally \{\s+setPending\(\(p\) => p\.filter\(\(u\) => u !== preview\)\);\s+if \(file instanceof Blob\) URL\.revokeObjectURL\(preview\);/);
    expect(added).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(added);
    expect(gone).toBeGreaterThan(read);
    expect(HOOK).toMatch(/return \{ loading: pending\.length > 0, pending, read \};/);
  });

  it("every reference strip renders the previews greyed after its images", () => {
    const greyed = /\{refsPending\.map\(\(src\) => \(\s+<div key=\{src\} className="[a-z-]+ enki-ref-pending"/;
    expect(MODAL).toMatch(/\{pendingReferenceImages\.map\(\(src\) => \(\s+<div key=\{src\} className="mobile-modal-ref-thumb enki-ref-pending"/);
    expect(LAUNCHER).toMatch(/pendingReferenceImages=\{refsPending\}/);
    expect(src("app", "globals.css")).toMatch(/\.enki-ref-pending \{ opacity: 0\.45; filter: grayscale\(1\); pointer-events: none; \}/);
  });

  it("a preview never enters a reference list, so no draft or generation carries one", () => {
    for (const [name, code] of [["launcher", LAUNCHER]] as const) {
      const uses = code.match(/refsPending/g) ?? [];
      const rendered = code.match(/refsPending\.(map|length)|=\{refsPending\}|pending: refsPending/g) ?? [];
      expect(uses.length, name).toBe(rendered.length);
    }
  });
});

it("the new reference tiles show pending previews as greyed", () => {
  expect(src("components", "kit", "ReferenceTiles.tsx")).toContain('className="kit-ref-img enki-ref-pending"');
});

it("the current Image View blocks a render while its references load", () => {
  expect(src("components", "image-view", "useImageViewModel.ts")).toContain('if (reads.loading) return { label: "Loading images…", why: REFS_LOADING };');
});
