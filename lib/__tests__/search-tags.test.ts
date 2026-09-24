import { describe, it, expect } from "vitest";
import vocabulary from "../search/vocabulary.json";
import { extractTags, mergeTags, stemmedKey, TAG_CAP } from "../search/tags";
import { stem } from "../search/stem";

/**
 * Zero cost search (Kev, 2026-09-24: "das muss dann kostenlos sein"): tags
 * come from a curated vocabulary matched in Node, never from a model. The
 * matcher runs on the plaintext inside the publish request, so what it
 * returns is the ONLY thing about a prompt body that ever reaches the index.
 * Every assertion here was broken on purpose once and seen red.
 */

type Entry = { tag: string; category: string; synonyms: string[] };
const entries = vocabulary as Entry[];
const CATEGORIES = ["subject", "style", "medium", "mood", "color", "composition", "technique"];
const tags = new Set(entries.map((e) => e.tag));

describe("vocabulary", () => {
  it("has at least 1,500 entries in the seven categories, each tag lowercase and unique", () => {
    expect(entries.length).toBeGreaterThanOrEqual(1500);
    expect(tags.size).toBe(entries.length);
    for (const e of entries) {
      expect(CATEGORIES, `${e.tag}: unknown category ${e.category}`).toContain(e.category);
      expect(e.tag).toBe(e.tag.toLowerCase().trim());
      expect(Array.isArray(e.synonyms)).toBe(true);
    }
    for (const c of CATEGORIES) expect(entries.some((e) => e.category === c), `no entries in ${c}`).toBe(true);
  });

  it("has no stemmed phrase that points at two different tags", () => {
    // A collision is silent: one of the two tags can never be matched again.
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const e of entries) {
      for (const phrase of [e.tag, ...e.synonyms]) {
        const k = stemmedKey(phrase);
        const prev = owner.get(k);
        if (prev && prev !== e.tag) collisions.push(`'${phrase}' (${e.tag}) collides with '${prev}'`);
        else owner.set(k, e.tag);
      }
    }
    expect(collisions).toEqual([]);
  });

  it("carries British spellings and shorthands as synonyms", () => {
    expect(extractTags("watercolour")).toEqual(["watercolor"]);
    expect(extractTags("b&w")).toEqual(["black and white"]);
    expect(extractTags("shot on 35mm")).toEqual(["35mm"]);
  });
});

describe("stem", () => {
  it("is a Porter stemmer", () => {
    expect(stem("paintings")).toBe("paint");
    expect(stem("painting")).toBe("paint");
    expect(stem("relational")).toBe("relat");
    expect(stem("hopefulness")).toBe("hope");
    expect(stem("cats")).toBe("cat");
    expect(stem("agreed")).toBe("agre");
  });
});

describe("extractTags", () => {
  it("strips [slot] placeholders, {{wf:...}} tokens and (word:1.3) weights", () => {
    const text = "portrait of a [dragon] in {{wf:node_7}} light, (golden hour:1.3), (oil painting)";
    const found = extractTags(text);
    expect(found).not.toContain("dragon");
    expect(found).toContain("golden hour");
    expect(found).toContain("oil painting");
    expect(found).toContain("portrait");
    // Without the weight rule the "1.1" would read as the 1:1 square format.
    expect(extractTags("(dragon:1.1)")).toEqual(["dragon"]);
    expect(extractTags("16:9")).toEqual(["widescreen"]);
  });

  it("matches a bigram as one tag", () => {
    expect(extractTags("shot during golden hour")).toContain("golden hour");
  });

  it("maps a synonym to its canonical tag", () => {
    expect(extractTags("a moody watercolour of a lorry")).toEqual(
      expect.arrayContaining(["moody", "watercolor", "truck"]),
    );
    expect(extractTags("a moody watercolour")).not.toContain("watercolour");
  });

  it("stems so an inflected word hits the base tag", () => {
    expect(extractTags("three paintings")).toContain("painting");
    expect(extractTags("two dragons flying")).toEqual(expect.arrayContaining(["dragon", "flying"]));
  });

  it("returns only vocabulary tags, never a word from the text", () => {
    expect(extractTags("florb quuxian zyzzyva gronk")).toEqual([]);
    const found = extractTags("a florb dragon in gronk light, cinematic, 8k, masterpiece, trending on artstation");
    for (const t of found) expect(tags.has(t), `${t} is not a vocabulary tag`).toBe(true);
    expect(found).not.toContain("masterpiece");
  });

  it("deduplicates and keeps the order of first appearance", () => {
    expect(extractTags("dragon, castle, dragon, castle, dragons")).toEqual(["dragon", "castle"]);
    expect(extractTags("castle then dragon")).toEqual(["castle", "dragon"]);
  });

  it("drops technique, color and composition for paid prompts", () => {
    const text = "a dragon in teal and orange, close up, cross hatching, oil painting, moody";
    expect(extractTags(text, { paid: false })).toEqual(
      expect.arrayContaining(["dragon", "teal and orange", "close up", "cross hatching", "oil painting", "moody"]),
    );
    const paid = extractTags(text, { paid: true });
    expect(paid).toEqual(expect.arrayContaining(["dragon", "oil painting", "moody"]));
    for (const dropped of ["teal and orange", "close up", "cross hatching"]) expect(paid).not.toContain(dropped);
  });

  it("does not use a paid category as a way in for other words", () => {
    // Every category the paid path keeps is one of the four broad ones.
    const kept = new Set(["subject", "style", "medium", "mood"]);
    const allText = entries.map((e) => e.tag).join(", ");
    for (const t of extractTags(allText, { paid: true })) {
      const e = entries.find((x) => x.tag === t)!;
      expect(kept.has(e.category), `${t} (${e.category}) leaked through the paid path`).toBe(true);
    }
  });
});

describe("mergeTags", () => {
  it("keeps the creator's tags first, deduplicates case insensitively and caps at 60", () => {
    expect(TAG_CAP).toBe(60);
    const creator = Array.from({ length: 70 }, (_, i) => `creator${i}`);
    const merged = mergeTags(creator, ["dragon"]);
    expect(merged).toHaveLength(60);
    expect(merged[0]).toBe("creator0");
    expect(merged).not.toContain("dragon");

    expect(mergeTags([" Dragon ", "castle"], ["dragon", "moody"])).toEqual(["dragon", "castle", "moody"]);
    expect(mergeTags([], [""])).toEqual([]);
  });
});
