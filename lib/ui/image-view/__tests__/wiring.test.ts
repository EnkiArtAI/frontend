import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/* Source pins, for wiring no behaviour test can reach without a browser:
   what the Image View keeps from the buyer page (report-ui,
   prompt-public-images, second-factor-bar) now that it replaces it, and
   where its controls meet the checks behind them (again.test, setups.test). */
const src = (...p: string[]) => readSource(join(__dirname, "..", "..", "..", "..", ...p));
const view = (file: string) => src("components", "image-view", file);
const MODEL = view("useImageViewModel.ts");
const HEADER = view("ComposerHeader.tsx");
const PANEL = view("ViewerPanel.tsx");
const DESKTOP = view("ImageViewDesktop.tsx");
const STRIP = view("PreviewStrip.tsx");
const MAIN = view("MainImage.tsx");
const TALK = view("Discussion.tsx");
const CSS = view("image-view.css");
const FRAME_CSS = view("image-view-frame.css");
const FRAME = src("components", "enki", "EnkiDetailPanel.tsx");

describe("Report", () => {
  it("sits in the header, on the prompt", () => {
    expect(HEADER).toMatch(/<ReportButton targetType="prompt" targetId=\{m\.promptId\}/);
  });

  it("sits in the viewer's panel, on someone else's public image, for a signed-in viewer", () => {
    expect(PANEL).toMatch(/\{shot\.publicId && !m\.guest && \(\n\s+<ReportButton targetType="generation" targetId=\{shot\.publicId\}/);
    // Never on the viewer's own: those are in the queue or the history, not among the public images.
    expect(MODEL).toContain(".filter((im) => !queued.has(im.url) && !recordOf(own.rows, im.url))");
  });
});

describe("the viewer", () => {
  it("is the kit's, at z 9999, over the frame and level with the report dialog", () => {
    expect(src("components", "kit", "kit-media.css")).toMatch(/\.kit-viewer \{\n\s+position: fixed;\n\s+inset: 0;\n\s+z-index: 9999;/);
    expect(DESKTOP).toMatch(/<FullscreenViewer [^]*?panel=\{\n\s+<ViewerPanel model=\{m\}/);
  });

  it("pages through every finished image of the page: renders, examples, public images, history", () => {
    expect(MODEL).toContain("const all = [...jobShots, ...examples, ...community, ...history];");
    // Each key once: a recorded render sits in the queue and in the history under one key (Kev, 2026-10-13).
    expect(MODEL).toContain("finished: [...new Map(all.filter((x) => x.src).map((x) => [x.key, x])).values()],");
    expect(DESKTOP).toContain("const keys = m.finished.map((x) => x.key);");
  });

  it("puts its panel under the picture on the stacked tier, where a 320 px side panel leaves the picture no room", () => {
    expect(DESKTOP).toContain('layout={tier === "stacked" ? "stacked" : "side"} nav={tier === "stacked" ? "dots" : "thumbs"}');
  });
});

describe("Regenerate and Retry (spec-imageview-mobile D10, plan R29)", () => {
  it("go through one checked path: the job's own price, then the low-balance question, then the queue", () => {
    expect(MODEL).toContain("const step = againStep(job.setup, price, { payer, ready: holdings.ready, balance: holdings.balance });");
    expect(MODEL).toContain("if (step.why) return notify(step.why);");
    expect(MODEL).toContain("if (step.funds) return setFunds({ balanceUsd: holdings.balance, totalUsd: step.funds.totalUsd, go });");
    expect(MODEL).toContain("tryAnyway: () => funds?.go(),");
  });

  it("Retry takes the failed job's place; Regenerate loads its setup back into the composer first", () => {
    expect(MODEL).toMatch(/const retried = job\.status === "failed" \? job\.id : undefined;\n\s+if \(!retried\) loadSetup\(job\.setup, true\);/);
    expect(MODEL).toMatch(/const go = \(\) => \{\n\s+start\(job\.setup, retried\);/);
    expect(MODEL).toMatch(/if \(retried\) queue\.retry\(retried\);\n\s+else runBatch\(\[job\]\);/);
  });

  it("are the only way past Generate to the queue: nothing else runs or retries a job", () => {
    expect(MODEL.match(/\brunBatch\(/g)).toHaveLength(1);
    expect(MODEL.match(/\.retry\(/g)).toHaveLength(2);
    expect(MODEL).toContain('if (job.status === "failed" && job.error?.payment) return queue.retry(job.id);');
    const again = MODEL.slice(MODEL.indexOf("const again = (job: Job<ImageSetup>"), MODEL.indexOf("/* ── Images:"));
    expect(again.indexOf("job.error?.payment")).toBeLessThan(again.indexOf("againStep("));
    expect(MODEL).not.toMatch(/\bretry: queue\.retry\b/);
  });

  it("show the job's own price on the button and take no press without it; the viewer closes first", () => {
    expect(PANEL).toContain("const again = useAgain(m, job);");
    expect(PANEL).toMatch(/data-primary disabled=\{!again\.ready\}\n\s+onClick=\{\(\) => \{\n\s+onAgain\(\);\n\s+again\.press\(\);/);
    expect(PANEL).toContain('{again.price && <span className="iv-vprice">{again.price}</span>}');
    expect(DESKTOP).toContain("onAgain={() => setViewer(null)}");
    expect(MAIN).toContain('const retry = useAgain(m, job?.status === "failed" ? job : undefined);');
    expect(MAIN).toContain("disabled={!retry.ready} onClick={retry.press}");
    expect(MAIN).toContain("⟳ {retry.label}{retry.price && ` · ${retry.price}`}");
    expect(MODEL).toContain('label: existingPayment ? "Check payment"');
    expect(MODEL).toContain("ready: existingPayment || free || price.quote !== null,");
  });
});

describe("the stage", () => {
  it("keeps its image when a new job goes in front, and shows the first one when there was none (handoff §0)", () => {
    expect(MODEL).toMatch(/const start = \(job: ImageSetup, retried\?: string\) => \{\n\s+setSelected\(\(k\) => k \?\? main\?\.key \?\? null\);/);
    expect(MODEL).toMatch(/if \(tooLargeToSend\(toRequest\(job\)\)\) return notify\(REFS_TOO_LARGE, \{ tone: "error" \}\);\n\s+start\(job\);\n\s+\};/);
  });
});

describe("a short balance (Kev, 2026-10-13)", () => {
  it("never reaches the checks or a job: the red button's press is Add funds, and a paid render says nothing under the button", () => {
    expect(MODEL).toContain("const short = balance?.short ? balance.text : null;");
    expect(MODEL).toMatch(/if \(guest\) return openLogin\(\);\n\s*if \(short !== null\) return openAddFunds\(\);\n\s+if \(gate\.why\) \{/);
    expect(MODEL).toContain("    if (!entry.free) return null;");
    expect(MODEL).not.toContain("Payment reserved");
    for (const view of ["ImageViewDesktop.tsx", "ImageViewMobile.tsx"]) {
      const text = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", view));
      expect(text, view).toContain("short={m.short}");
      expect(text, view).toContain("<CostLine left={m.cost} />");
    }
  });
});

describe("the strip", () => {
  it("tells a screen reader \"not charged\" only where nothing can have been charged", () => {
    expect(STRIP).toContain("label={`Your render, ${jobSaid(s.job)}`}");
    expect(STRIP).toContain('{!newest ? "" : newest.status === "rendering" ? "Rendering…" : `Render ${jobSaid(newest)}`}');
    expect(STRIP).not.toContain("not charged");
  });
});

describe("likes", () => {
  it("are read through loadLikes, whose failure leaves the query to ask again", () => {
    expect(MODEL).toContain("queryFn: () => loadLikes(promptId as string, sessionAuthHeaders()),");
  });
});

describe("Esc in the frame", () => {
  it("is heard after the view's own layers and fields, and never reaches the shell's panel under the view", () => {
    expect(FRAME).toContain('document.addEventListener("keydown", onKey);');
    expect(FRAME).toContain('document.removeEventListener("keydown", onKey);');
    expect(FRAME).not.toContain('window.addEventListener("keydown"');
    expect(FRAME).toMatch(/if \(e\.key !== "Escape" \|\| hidden \|\| e\.cancelBubble\) return;\n\s+e\.preventDefault\(\);\n\s+e\.stopPropagation\(\);\n\s+onClose\(\);/);
  });
});

describe("on a touch screen", () => {
  it("a review star's target grows up and down only, never into the next star", () => {
    expect(TALK).toContain('className="iv-star" data-on=');
    expect(CSS).toMatch(/@media \(pointer: coarse\) \{\n\s+\.iv-star \{ position: relative; \}\n\s+\.iv-star::after \{\n\s+content: "";\n\s+position: absolute;\n\s+left: 0;\n\s+right: 0;\n\s+top: 50%;\n\s+height: 44px;/);
  });

  it("no field is under 16 px, so iOS does not zoom on focus", () => {
    expect(CSS).toMatch(/@media \(pointer: coarse\) \{\n\s+\.iv-input,\n\s+\.iv-inline,\n\s+\.iv-tok \{ font-size: 16px; \}/);
  });
});

describe("on a phone", () => {
  it("the Comments | Reviews switch drops \"requires purchase\", and the column never scrolls sideways", () => {
    expect(CSS).toMatch(/@media \(max-width: 767\.98px\) \{\n\s+\.iv-talk-tabs \.iv-dim \{ display: none; \}/);
    expect(CSS).toMatch(/\.iv-stack \{[^}]*overflow: hidden auto;/);
  });
});

describe("the Public switch", () => {
  it("is on the viewer's own recorded render, and says who sees it", () => {
    expect(PANEL).toContain("onChange={(e) => void m.setPublic(record, e.target.checked)} />");
    expect(PANEL).toContain('{record.visibility !== "public" ? "Only you see it"');
    expect(PANEL).toContain(': record.prompt_id === m.promptId ? "Shown under this prompt and on your profile" : "Shown on your profile"}');
  });

  it("finds a fresh render's record by its URL once the history read has it (recordOf skips uploads)", () => {
    expect(MODEL).toContain("ratio: j.setup.aspectRatio, job: j, record: j.imageUrl ? recordOf(own.rows, j.imageUrl) : undefined,");
  });

  it("makes it public or private, and every row that shows it follows", () => {
    expect(MODEL).toContain("fetch(`/api/images/${encodeURIComponent(row.id)}`, {\n      method: \"PATCH\",");
    expect(MODEL).toContain('body: JSON.stringify({ visibility: on ? "public" : "private" }),');
    expect(MODEL).toContain('void queryClient.invalidateQueries({ queryKey: ["user-generations"] });\n    void queryClient.invalidateQueries({ queryKey: ["prompt-public-images"] });');
  });
});

describe("images made with this prompt", () => {
  it("are read with the viewer's headers (the 18+ pill)", () => {
    expect(MODEL).toContain("fetch(`/api/prompts/${encodeURIComponent(promptId as string)}/images`, { headers: viewerHeaders() })");
  });

  it("follow the creator's examples in the strip", () => {
    expect(STRIP).toContain("const tiles = [...m.examples, ...m.community];");
    expect(STRIP).toMatch(/\{m\.queue\.map\([^]*\{tiles\.map\(/);
  });
});

describe("the frame", () => {
  it("starts below the recovery banner and beside the shell's menu, under the sidebar", () => {
    const frame = /\.iv-frame \{([^}]*)\}/.exec(FRAME_CSS)?.[1] ?? "";
    expect(frame).toContain("top: var(--ek-banner-h, 0px);");
    expect(frame).toContain("left: var(--ek-sw, 0px);");
    expect(frame).toContain("z-index: 162;");
    expect(FRAME_CSS).toMatch(/\.iv-page \{[^}]*height: calc\(100dvh - var\(--ek-banner-h, 0px\)\);/);
  });
});
