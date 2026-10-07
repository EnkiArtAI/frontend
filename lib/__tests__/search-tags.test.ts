import { describe, it, expect } from "vitest";
import vocabulary from "../search/vocabulary.json";
import { extractTags, storedTags, stemmedKey, TAG_CAP, PAID_SUBJECT_CAP } from "../search/tags";
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

  it("keeps only what a paid prompt shows, never how it is made", () => {
    const text = "a dragon in teal and orange, close up, cross hatching, oil painting, moody";
    expect(extractTags(text, { paid: false })).toEqual(
      expect.arrayContaining(["dragon", "teal and orange", "close up", "cross hatching", "oil painting", "moody"]),
    );
    expect(extractTags(text, { paid: true })).toEqual(["dragon"]);
  });

  it("lets no other category through the paid path, and at most five subjects", () => {
    expect(PAID_SUBJECT_CAP).toBe(5);
    const allText = entries.map((e) => e.tag).join(", ");
    const paid = extractTags(allText, { paid: true });
    expect(paid).toHaveLength(5);
    for (const t of paid) expect(entries.find((x) => x.tag === t)!.category, t).toBe("subject");
  });

  it("gives a buyer nothing to distil a paid recipe from (Kev, 2026-10-07)", () => {
    // Five recipe-heavy paid prompts: their lighting, lens, renderer, film
    // stock and director style must not survive, only their subjects.
    const recipes = [
      "portrait of an elderly fisherman, rembrandt lighting, chiaroscuro, 85mm lens, kodak portra 400, film grain, shallow depth of field",
      "a dragon over ruins of a church, storm clouds, god rays, volumetric lighting, octane render, unreal engine, trending on artstation",
      "macro still life of a glass bottle, caustics, rim light, high key lighting, reflections, gold and black palette, 16mm film",
      "a girl riding a bicycle through the countryside, ghibli style, cel shaded, soft pastel colors, wes anderson style, symmetrical composition",
      "a hotel lobby, kubrick style one point perspective, muted colors, natural light, long exposure, award winning photography",
    ];
    const RECIPE = /lighting|light|chiaroscuro|mm\b|portra|grain|depth|rays|volumetric|render|engine|caustic|key|reflection|palette|film|ghibli|cel|pastel|anderson|symmetr|kubrick|perspective|muted|exposure|award|photograph/;
    for (const r of recipes) {
      const paid = extractTags(r, { paid: true });
      expect(paid.length, r).toBeLessThanOrEqual(5);
      for (const t of paid) {
        expect(entries.find((x) => x.tag === t)!.category, `${t} from: ${r}`).toBe("subject");
        expect(t, `${t} carries the recipe`).not.toMatch(RECIPE);
      }
    }
    expect(extractTags(recipes[1], { paid: true })).toEqual(expect.arrayContaining(["dragon", "ruins", "church"]));
  });

  it("keeps named looks, era, gear and lighting out of a paid body's tags", () => {
    expect(extractTags("portrait of a woman, shot on iphone, candlelight, foggy 1980s mood, silhouetted, in the style of van gogh", { paid: true })).toEqual(["woman"]);
    expect(extractTags("cinematic film still, blade runner aesthetic, eye contact, dust particles, neon", { paid: true })).toEqual([]);
    expect(extractTags("a knight, lord of the rings, game of thrones, star wars", { paid: true })).toEqual(["knight"]);
  });

  it("lets the longest term own its words", () => {
    expect(extractTags("god rays over the sea")).not.toContain("god");
    expect(extractTags("rendered in unreal engine")).not.toContain("engine");
    expect(extractTags("high key lighting")).not.toContain("key");
  });

  it("makes no tag out of ordinary prompt words", () => {
    const filler = (
      "the a an and or but of in on at to for with by from as is are was were be been being it its this that these those " +
      "very highly extremely more most less some any all each every other another such no not only just also too so than then " +
      "there here where when while into onto over under above below between through during before after about against among " +
      "around behind beside beyond near off out up down within without high quality resolution best perfect " +
      "sharp focus hyper hd professional shot image picture render rendered made create show showing " +
      "looking look looks style styled styles frame framed framing set setting settings long short soft softly wet clean natural " +
      "angle angled angles field fields ray award awarded shade shaded shading palette muted lots little big large small " +
      "huge tiny full half new old first last next one two three many few several wide narrow left right top bottom middle " +
      "side front back towards could would should might must will can may do does did done have has had get got take takes " +
      "taking give gives giving use uses using way ways thing things something nothing everything anything"
    ).split(" ");
    expect(filler.length).toBeGreaterThanOrEqual(150);
    const hits = filler.map((w) => [w, extractTags(w)] as const).filter(([, t]) => t.length > 0);
    expect(hits).toEqual([]);
  });
});

describe("storedTags", () => {
  it("deduplicates case insensitively, caps at 40 in priority order, then sorts", () => {
    expect(TAG_CAP).toBe(40);
    expect(storedTags([" Dragon ", "castle"], ["dragon", "moody"], [""])).toEqual(["castle", "dragon", "moody"]);
    const many = Array.from({ length: 50 }, (_, i) => `tag${String(i).padStart(2, "0")}`);
    // The first group's tags survive the cap however late they sort.
    expect(storedTags(["zebra"], many)).toContain("zebra");
    expect(storedTags(many.slice().reverse())).toEqual(many.slice(10).sort());
  });
});
