import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { failureSentence, flattenSuggestions, stepActive, SUGGEST_TITLES, SUGGEST_CREATORS } from "../search/client";
import { SEARCH_NOT_MIGRATED_MESSAGE } from "../search/db";

/**
 * The shell search's client half (FE-02): the feed asks /api/search instead
 * of filtering the loaded page by substring, the field asks
 * /api/search/suggest, a 503 reaches the screen as the server's own
 * sentence, and the typeahead list stays within 8 titles and 4 creators
 * with wrap around arrow keys. Tags never reach the UI.
 */

const ROOT = join(__dirname, "..", "..");
const feed = readSource(join(ROOT, "components/enki/EnkiFeedPage.tsx"));
const filters = readSource(join(ROOT, "components/enki/EnkiFilters.tsx"));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("failureSentence", () => {
  it("shows the 503 sentence verbatim", async () => {
    const res = json(503, { error: SEARCH_NOT_MIGRATED_MESSAGE, code: "SEARCH_NOT_MIGRATED" });
    expect(await failureSentence(res, "Search failed")).toBe("Search is not migrated yet.");
  });
  it("falls back to one short sentence with the status when the body has none", async () => {
    expect(await failureSentence(json(500, {}), "Search failed")).toBe("Search failed (HTTP 500).");
    expect(await failureSentence(new Response("<html>", { status: 502 }), "Search failed")).toBe("Search failed (HTTP 502).");
  });
});

describe("flattenSuggestions", () => {
  const titles = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, title: `Title ${i}` }));
  const creators = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, handle: `kev${i}`, displayName: i % 2 ? "" : `Kev ${i}`, avatarUrl: null }));

  it("caps at 8 titles then 4 creators, titles first", () => {
    const items = flattenSuggestions({ titles, creators });
    expect(items).toHaveLength(SUGGEST_TITLES + SUGGEST_CREATORS);
    expect(items.slice(0, 8).every((i) => i.kind === "title")).toBe(true);
    expect(items.slice(8).every((i) => i.kind === "creator")).toBe(true);
  });
  it("labels a creator by display name, else by handle, and keeps the handle to open", () => {
    const [a, b] = flattenSuggestions({ titles: [], creators: creators.slice(0, 2) });
    expect(a).toEqual({ kind: "creator", id: "c0", label: "Kev 0", handle: "kev0" });
    expect(b).toEqual({ kind: "creator", id: "c1", label: "kev1", handle: "kev1" });
  });
  it("survives a body that is not the contract", () => {
    expect(flattenSuggestions(null)).toEqual([]);
    expect(flattenSuggestions({ titles: "x", creators: [{ id: 1 }, { handle: "no-id" }] })).toEqual([]);
  });
  it("carries no tags whatever the server sends", () => {
    const items = flattenSuggestions({ titles: [{ id: "t", title: "Dragon", tags: ["dragon"] }], creators: [] });
    expect(Object.keys(items[0])).toEqual(["kind", "id", "label"]);
  });
});

describe("stepActive", () => {
  it("walks down from the field through every row and back to the field", () => {
    const seen: number[] = [];
    let a = -1;
    for (let i = 0; i < 4; i++) { a = stepActive(a, 1, 3); seen.push(a); }
    expect(seen).toEqual([0, 1, 2, -1]);
  });
  it("walks up from the field onto the last row", () => {
    expect(stepActive(-1, -1, 3)).toBe(2);
    expect(stepActive(0, -1, 3)).toBe(-1);
  });
  it("stays on the field when the list is empty", () => {
    expect(stepActive(-1, 1, 0)).toBe(-1);
    expect(stepActive(5, -1, 0)).toBe(-1);
  });
});

describe("shell search wiring", () => {
  it("the feed asks /api/search with type=all and the debounced query", () => {
    expect(feed).toMatch(/fetch\(`\/api\/search\?\$\{params/);
    expect(feed).toMatch(/type: "all"/);
    expect(feed).toMatch(/useDebounced\(typed, SEARCH_DEBOUNCE_MS\)/);
  });
  it("the feed no longer filters the loaded page by substring", () => {
    expect(feed).not.toMatch(/\.toLowerCase\(\)\.includes\(/);
  });
  it("a failed search reaches the screen as the server's sentence", () => {
    expect(feed).toMatch(/throw new Error\(await failureSentence\(res, "Search failed"\)\)/);
  });
  it("the feed opens a found creator inside the shell", () => {
    expect(feed).toMatch(/openCreator\(c\.handle, router\)/);
  });
  it("the field asks /api/search/suggest and never mentions tags", () => {
    expect(filters).toMatch(/fetch\(`\/api\/search\/suggest\?q=/);
    expect(filters).toMatch(/SUGGEST_DEBOUNCE_MS/);
    expect(filters).not.toMatch(/placeholder="[^"]*tags/i);
    expect(filters).not.toMatch(/item\.tags|\.tags\b/);
  });
  it("the typeahead is keyboard driven", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) expect(filters).toContain(`"${key}"`);
    expect(filters).toMatch(/stepActive\(active,/);
  });
});
