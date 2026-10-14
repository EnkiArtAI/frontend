import { describe, it, expect } from "vitest";
import {
  variations, variationKey, valuesKey, letterAt, varyColor, withVariation, previewList, siblingTag,
  needFor, canStar, starred, toggleStar, starsForFree, type Stars,
} from "../variations";
import type { EditorSetup } from "../generate-checks";
import type { Job } from "@/lib/ui/kit/render-queue";

type J = Job<EditorSetup>;
const setup = (prompt: string, vars: Record<string, string> = {}): EditorSetup => ({
  prompt, vars, kinds: {}, refIds: [], modelId: "m", modelName: "M", ratio: "1:1", resolution: "2K", boost: false,
});
const job = (id: string, createdAt: number, prompt: string, vars: Record<string, string> = {}, o: Partial<J> = {}): J => ({
  id, createdAt, status: "ready", imageUrl: `https://x/${id}.webp`, seen: false, setup: setup(prompt, vars), ...o,
});
const ids = (jobs: J[]) => jobs.map((j) => j.id);

describe("keys", () => {
  it("a variation is one prompt text; values change only the stack", () => {
    const a = setup("a [x] ", { x: "1" });
    expect(variationKey(a)).toBe(variationKey(setup("a [x]", { x: "2" })));
    expect(variationKey(a)).not.toBe(variationKey(setup("a [y]", { y: "1" })));
    expect(valuesKey(a)).toBe(JSON.stringify(["1"]));
    expect(valuesKey(setup("[x] [y]", { y: "2", other: "z" }))).toBe(JSON.stringify(["", "2"]));
  });

  it("letters run A…Z, AA, AB … ZZ, AAA", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(letterAt)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("colours are the six vary tokens in turn", () => {
    expect([0, 5, 6, 13].map(varyColor)).toEqual(["var(--enki-vary-1)", "var(--enki-vary-6)", "var(--enki-vary-1)", "var(--enki-vary-2)"]);
  });

  it("withVariation adds a key once, at the end", () => {
    const order = ["a", "b"];
    expect(withVariation(order, "c")).toEqual(["a", "b", "c"]);
    expect(withVariation(order, "a")).toBe(order);
  });
});

describe("variations", () => {
  it("are newest first, and keep the letter and colour of when they first appeared", () => {
    const jobs = [job("b1", 2, "p2"), job("a1", 1, "p1")];
    const two = variations(jobs, ["p1", "p2"]);
    expect(two.map((g) => [g.key, g.letter, g.color])).toEqual([["p2", "B", "var(--enki-vary-2)"], ["p1", "A", "var(--enki-vary-1)"]]);
    const three = variations([job("c1", 3, "p3"), ...jobs], ["p1", "p2", "p3"]);
    expect(three.map((g) => [g.key, g.letter, g.color])).toEqual([
      ["p3", "C", "var(--enki-vary-3)"],
      ["p2", "B", "var(--enki-vary-2)"],
      ["p1", "A", "var(--enki-vary-1)"],
    ]);
  });

  it("keep their place when an old one gets a new render, and their letter when an older one has none left", () => {
    expect(variations([job("a2", 9, "p1"), job("b1", 2, "p2"), job("a1", 1, "p1")], ["p1", "p2"]).map((g) => g.letter)).toEqual(["B", "A"]);
    expect(variations([job("b1", 2, "p2")], ["p1", "p2"]).map((g) => g.letter)).toEqual(["B"]);
  });

  it("place keys the order does not know yet after it, by their first render", () => {
    const groups = variations([job("y", 5, "py"), job("x2", 6, "px"), job("x1", 4, "px"), job("k", 1, "pk")], ["pk"]);
    expect(groups.map((g) => [g.key, g.letter])).toEqual([["py", "C"], ["px", "B"], ["pk", "A"]]);
  });

  it("hold every render newest first, the names of the text, and stacks of equal values", () => {
    const jobs = [
      job("c3", 5, "a [x]", { x: "cat" }),
      job("d2", 4, "a [x]", { x: "dog" }, { status: "failed" }),
      job("d1", 3, "a [x] ", { x: "dog" }),
      job("c1", 1, "a [x]", { x: "cat" }, { status: "rendering" }),
    ];
    const [g] = variations(jobs, ["a [x]"]);
    expect(ids(g.jobs)).toEqual(["c3", "d2", "d1", "c1"]);
    expect(g.names).toEqual(["x"]);
    // The cat stack began first: its new render goes on top of it, and the stack stays where it was.
    expect(g.stacks.map((s) => [s.key, ids(s.jobs)])).toEqual([
      [JSON.stringify(["dog"]), ["d2", "d1"]],
      [JSON.stringify(["cat"]), ["c3", "c1"]],
    ]);
  });

  it("previewList pages through ready renders, newest variation first, newest first within it", () => {
    const groups = variations([job("b2", 4, "p2"), job("a2", 3, "p1"), job("b1", 2, "p2", {}, { status: "rendering" }), job("a1", 1, "p1")], ["p1", "p2"]);
    expect(ids(previewList(groups))).toEqual(["b2", "a2", "a1"]);
  });

  it("siblingTag names the one value that differs, or counts them", () => {
    const a = setup("[mood] [light]", { mood: "calm", light: "dusk" });
    expect(siblingTag(a, { vars: { mood: "calm", light: "dusk" } })).toBe("");
    expect(siblingTag(a, { vars: { mood: "wild", light: "dusk" } })).toBe("≠ mood");
    expect(siblingTag(a, { vars: { mood: "wild" } })).toBe("≠ 2 vars");
  });
});

describe("stars", () => {
  const p = [job("p1", 1, "same"), job("p2", 2, "same"), job("p3", 3, "same"), job("p4", 4, "same"), job("p5", 5, "same")];
  const other = job("o1", 6, "other");
  const jobs = [...p, other, job("d", 7, "same", {}, { imageUrl: "data:image/png;base64,AA" }), job("r", 8, "same", {}, { status: "rendering" })];
  const star = (stars: Stars, id: string, need: number, now = 100) => toggleStar(stars, jobs, id, need, now);

  it("a release takes 1 star for Free and 4 for Premium", () => {
    expect([needFor("free"), needFor("premium")]).toEqual([1, 4]);
  });

  it("only a stored (https) render that is ready can be starred", () => {
    expect(jobs.map(canStar)).toEqual([true, true, true, true, true, true, false, false]);
    expect(star({}, "d", 4)).toEqual({ stars: {}, toast: "This render wasn't stored, so it can't be a showcase image" });
    expect(star({}, "r", 4).stars).toEqual({});
    expect(star({ p1: 1 }, "nope", 4)).toEqual({ stars: { p1: 1 } });
  });

  it("stars with the time it was given, and unstars always", () => {
    expect(star({ p1: 1 }, "p2", 4, 7)).toEqual({ stars: { p1: 1, p2: 7 } });
    expect(star({ p1: 1, p2: 2 }, "p1", 4)).toEqual({ stars: { p2: 2 } });
  });

  it("Free is a radio: the star moves", () => {
    expect(star({ p1: 1 }, "p2", 1)).toEqual({ stars: { p2: 100 } });
  });

  it("Premium refuses a fifth star", () => {
    const four = { p1: 1, p2: 2, p3: 3, p4: 4 };
    expect(star(four, "p5", 4)).toEqual({ stars: four, toast: "A release takes exactly 4 — unstar one first" });
  });

  it("a star in another variation clears the others and says why", () => {
    expect(star({ p1: 1, p2: 2 }, "o1", 4)).toEqual({ stars: { o1: 100 }, toast: "Stars moved to this variation — all 4 must come from one" });
    expect(star({ p1: 1 }, "o1", 1)).toEqual({ stars: { o1: 100 }, toast: "Star moved to this variation" });
  });

  it("counts only stars of renders that are still there, in star order", () => {
    expect(ids(starred({ p3: 1, p1: 3, gone: 0, p2: 2 }, jobs))).toEqual(["p3", "p2", "p1"]);
    expect(star({ gone: 0, p1: 1, p2: 2, p3: 3 }, "p4", 4).stars).toEqual({ gone: 0, p1: 1, p2: 2, p3: 3, p4: 100 });
  });

  it("Premium → Free keeps the earliest star", () => {
    expect(starsForFree({ p2: 5, p1: 9, p3: 7 }, jobs)).toEqual({ stars: { p2: 5 }, toast: "Free releases with 1 image — kept your first star" });
    expect(starsForFree({ p2: 5 }, jobs)).toEqual({ stars: { p2: 5 } });
    expect(starsForFree({}, jobs)).toEqual({ stars: {} });
  });
});
