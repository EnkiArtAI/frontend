import { describe, expect, it } from "vitest";
import { DOCS, FAQ } from "@/components/settings/docs-content";

/* The How Enki works copy has hard rules: no dash of any kind (Kev's
   "without bindestriche"), paragraphs a 15 year old reads in one go, and a
   1,600 word ceiling so the tab stays a read, not a manual. Each rule here
   was proven able to fail by breaking the copy once (see the commit). */

const DASH = /[-‐-―−]/;
const SECTION_ORDER = [
  "What Enki is",
  "Getting in",
  "The feed and prompts",
  "Making images",
  "What it costs",
  "Paying and your wallet",
  "Selling your prompts",
  "Your gallery and profile",
  "Bookmarks, notifications and Hall of Fame",
  "Staying safe",
  "For developers and AI agents",
  "Where to ask",
];

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const sentences = (s: string) => s.split(/[.!?]+(?:\s+|$)/).filter((p) => p.trim()).length;

const allStrings = [
  ...DOCS.flatMap((d) => [d.id, d.title, d.summary, ...d.body]),
  ...FAQ.flatMap((f) => [f.q, f.a]),
];

describe("docs-content", () => {
  it("has the twelve sections in order and none of them empty", () => {
    expect(DOCS.map((d) => d.title)).toEqual(SECTION_ORDER);
    for (const d of DOCS) {
      expect(d.id, d.title).toMatch(/^[a-z]+$/);
      expect(d.summary.trim(), d.title).not.toBe("");
      expect(d.body.length, d.title).toBeGreaterThan(0);
      for (const p of d.body) expect(p.trim(), d.title).not.toBe("");
    }
  });

  it("contains no dash character in any string", () => {
    const hits = allStrings.filter((s) => DASH.test(s));
    expect(hits).toEqual([]);
  });

  it("keeps every body paragraph at 4 sentences and 90 words or fewer", () => {
    const long = DOCS.flatMap((d) =>
      d.body
        .map((p) => ({ section: d.id, sentences: sentences(p), words: words(p), p }))
        .filter((x) => x.sentences > 4 || x.words > 90),
    );
    expect(long).toEqual([]);
  });

  it("stays under 1,600 words in total", () => {
    const total = allStrings.reduce((n, s) => n + words(s), 0);
    expect(total).toBeLessThan(1600);
  });

  it("has 8 to 12 FAQ entries, each answered in one or two sentences", () => {
    expect(FAQ.length).toBeGreaterThanOrEqual(8);
    expect(FAQ.length).toBeLessThanOrEqual(12);
    for (const f of FAQ) {
      expect(f.q.trim(), f.q).not.toBe("");
      expect(sentences(f.a), f.q).toBeGreaterThanOrEqual(1);
      expect(sentences(f.a), f.q).toBeLessThanOrEqual(2);
    }
  });
});
