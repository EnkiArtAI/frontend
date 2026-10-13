import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import HistoryRail, { railItems } from "@/components/image-view/HistoryRail";
import PreviewStrip from "@/components/image-view/PreviewStrip";
import type { ImageViewModel, Shot } from "@/components/image-view/useImageViewModel";

/**
 * A render of this tab is in the History rail from the moment it starts, not
 * under the stage (Kev, 2026-10-13: "das generierende Bild soll nicht UNTER
 * dem Hauptbild stehen sondern in der History ganz rechts").
 */

const job = (id: string, status: "rendering" | "failed" | "ready", over: Partial<Shot> = {}, sent = status === "rendering"): Shot => ({
  key: `job:${id}`, kind: "job", ratio: "4:5", src: status === "ready" ? `/${id}.png` : undefined, thumb: status === "ready" ? `/${id}.png` : undefined,
  job: { id, status, sent, seen: false } as Shot["job"], ...over,
});
const row = (id: string): Shot => ({ key: `history:${id}`, kind: "history", ratio: null, src: `/${id}.webp`, thumb: `/${id}.webp`, createdAt: "2026-10-12T10:00:00Z" });
const example: Shot = { key: "example:0", kind: "example", ratio: "4:5", src: "/ex.png", thumb: "/ex.png" };

const model = (queue: Shot[], history: Shot[]): ImageViewModel => ({
  queue, history, jobs: queue.map((s) => s.job), examples: [example], community: [], main: null, now: Date.parse("2026-10-13T10:00:00Z"),
  historyState: { loading: false, failed: false, more: false, loadingOlder: false, retry: vi.fn(), loadOlder: vi.fn() },
  select: vi.fn(), cancel: vi.fn(),
} as unknown as ImageViewModel);

const rail = (m: ImageViewModel, open = true) => renderToStaticMarkup(createElement(HistoryRail, { model: m, drawer: false, open, onToggle: vi.fn() }));
const strip = (m: ImageViewModel, queue: boolean) => renderToStaticMarkup(createElement(PreviewStrip, { model: m, queue }));

describe("railItems", () => {
  it("puts this tab's renders first, then the history", () => {
    expect(railItems([job("b", "rendering"), job("a", "failed")], [row("x"), row("y")]).map((s) => s.key))
      .toEqual(["job:b", "job:a", "history:x", "history:y"]);
  });

  it("lists a recorded render once: where the history has it", () => {
    const recorded = job("a", "ready", { createdAt: "2026-10-13T09:59:00Z" });
    expect(railItems([job("b", "rendering"), recorded], [recorded, row("x")]).map((s) => s.key)).toEqual(["job:b", "job:a", "history:x"]);
  });
});

describe("the History rail", () => {
  it("shows a render from the moment it starts, above the older ones, and says where it stands", () => {
    const html = rail(model([job("b", "rendering"), job("a", "failed")], [row("x")]));
    expect(html).toContain("History · 3");
    const [rendering, failed, old] = [html.indexOf('data-status="rendering"'), html.indexOf('data-status="failed"'), html.indexOf("/x.webp")];
    expect(rendering).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(rendering);
    expect(old).toBeGreaterThan(failed);
    expect(html).toContain("<span>Rendering…</span>");
    expect(html).toContain("<span>Failed</span>");
    expect(html).toContain('aria-label="Your render, rendering"');
    expect(html).toContain('<span class="iv-sr" role="status">Rendering…</span>');
  });

  it("a finished render shows its image at once, and its time once it is recorded", () => {
    expect(rail(model([job("a", "ready")], []))).toContain("<span>Just now</span>");
    const recorded = job("a", "ready", { createdAt: "2026-10-13T09:00:00Z" });
    const html = rail(model([recorded], [recorded]));
    expect(html).toContain("History · 1");
    expect(html).toContain('src="/a.png"');
    expect(html).not.toContain("Just now");
    expect(html).toContain("<span>1h ago</span>");
  });

  it("folded, its small strip still shows a running and a failed render, and whether the running one was sent", () => {
    const html = rail(model([job("b", "rendering"), job("c", "rendering", {}, false), job("a", "failed")], [row("x")]), false);
    expect(html).toContain('class="iv-mini" data-status="rendering" data-sent="true"');
    expect(html).toMatch(/class="iv-mini" data-status="rendering"><\/span>/);
    expect(html).toContain('class="iv-mini" data-status="failed"');
  });

  it("a render still in line carries an X that cancels it through the model; a sent one is lit and has none (Kev, 2026-10-13)", () => {
    const inLine = job("q", "rendering", {}, false);
    const m = model([job("s", "rendering"), inLine], []);
    const html = rail(m);
    const tiles = html.match(/<div class="kit-tile kit-focus"[^>]*>/g) ?? [];
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toContain('data-sent="true"');
    expect(tiles[1]).not.toContain("data-sent");
    expect(html.match(/aria-label="Cancel this render"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Your render, rendering"');
    expect(html).toContain('aria-label="Your render, in line, cancel with its X"');
    // The X is wired to the model's cancel with the shot, like select.
    const rail_ = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "HistoryRail.tsx"));
    expect(rail_).toContain("onClick={() => m.select(s)} onCancel={() => m.cancel(s)} />");
    for (const file of ["PreviewStrip.tsx", "ImageViewMobile.tsx"]) {
      const text = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", file));
      expect(text, file).toContain("sent={s.job.sent}");
      expect(text, file).toContain("onCancel={() => m.cancel(s)}");
    }
    const modelSrc = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"));
    expect(modelSrc).toContain("cancel: (shot) => { if (shot.job) queue.cancel(shot.job.id); },");
  });

  it("says so when there is nothing yet", () => {
    expect(rail(model([], []))).toContain("No renders of this prompt yet");
  });

  it("marks a recorded render of the viewer's as private or public, and nothing that is not recorded (Kev, 2026-10-13)", () => {
    const record = (id: string, visibility: "public" | "private") => ({
      id, image_url: `/${id}.png`, image_urls: [], thumbnail_url: null, isUploaded: false, visibility, prompt_id: "p1", created_at: "2026-10-13T09:00:00Z",
    });
    const mine = { ...row("a"), record: record("a", "private") };
    const shared = { ...row("b"), record: record("b", "public") };
    const html = rail(model([job("c", "rendering")], [mine, shared]));
    const marks = html.match(/<button type="button" class="iv-hpub kit-hit"[^>]*>/g) ?? [];
    expect(marks).toHaveLength(2);
    expect(marks[0]).toContain('aria-pressed="false"');
    expect(marks[0]).toContain('aria-label="Private · share it"');
    expect(marks[0]).not.toContain("data-on");
    expect(marks[1]).toContain('data-on="true"');
    expect(marks[1]).toContain('aria-label="Public · make it private"');
    // The mark is a sibling of the pick, never a button inside a button.
    expect(html).not.toMatch(/<button[^>]*class="iv-hitem-pick"[^>]*>(?:(?!<\/button>).)*<button/);
  });
});

describe("the strip under the stage", () => {
  it("beside a rail it holds the examples only: no render of this tab", () => {
    const html = strip(model([job("b", "rendering")], []), false);
    expect(html).toContain("/ex.png");
    expect(html).not.toContain("kit-tile");
    expect(html).not.toContain("Rendering…");
  });

  it("without a rail (stacked tier, blank composer) the renders lead it, as before", () => {
    const html = strip(model([job("b", "rendering")], []), true);
    expect(html.indexOf('data-status="rendering"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-status="rendering"')).toBeLessThan(html.indexOf("/ex.png"));
    expect(html).toContain('<span class="iv-sr" role="status">Rendering…</span>');
  });

  it("with nothing to show beside a rail it is not drawn at all, even while a render runs", () => {
    const m = model([job("b", "rendering")], []);
    (m as { examples: Shot[] }).examples = [];
    expect(strip(m, false)).toBe("");
    expect(strip(m, true)).not.toBe("");
  });
});
