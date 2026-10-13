import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { linkedPrompt, promptLink } from "../open-link";

/**
 * A reload on an open Image View stays on the image (Kev, 2026-10-13: "wenn
 * ich aktualisieren klicke … will ich weiterhin auf dem Image bleiben und
 * nicht erneut in Home reinkommen"): the open prompt is in the address.
 */

const ID = "db1ba7e7-a803-4e7f-8934-93f2180db816";

describe("promptLink", () => {
  it("adds the open prompt to the address and keeps everything else of it", () => {
    expect(promptLink("http://enki.test/home", ID)).toBe(`/home?prompt=${ID}`);
    expect(promptLink("http://enki.test/home?q=cat&creator=kev#top", ID)).toBe(`/home?q=cat&creator=kev&prompt=${ID}#top`);
  });

  it("replaces another prompt, and takes it away on close", () => {
    const other = "11111111-1111-4111-8111-111111111111";
    expect(promptLink(`http://enki.test/home?prompt=${other}&q=cat`, ID)).toBe(`/home?prompt=${ID}&q=cat`);
    expect(promptLink(`http://enki.test/home?prompt=${ID}&q=cat`, null)).toBe("/home?q=cat");
    expect(promptLink(`http://enki.test/home?prompt=${ID}`, null)).toBe("/home");
  });
});

describe("linkedPrompt", () => {
  it("reads the prompt an address asks to open", () => {
    expect(linkedPrompt(`?q=cat&prompt=${ID}`)).toBe(ID);
    expect(linkedPrompt(new URLSearchParams({ prompt: ID.toUpperCase() }))).toBe(ID.toUpperCase());
  });

  it("opens nothing for an address without one, or with anything that is not an id", () => {
    expect(linkedPrompt("?q=cat")).toBeNull();
    expect(linkedPrompt("?prompt=")).toBeNull();
    expect(linkedPrompt("?prompt=../../api/admin")).toBeNull();
    expect(linkedPrompt(`?prompt=${ID}x`)).toBeNull();
  });
});

describe("the wiring", () => {
  const src = (...p: string[]) => readSource(join(__dirname, "..", "..", "..", "..", "components", ...p));

  it("the view writes its prompt into the address while it is open, without a navigation, and never for the blank composer", () => {
    const panel = src("enki", "EnkiDetailPanel.tsx");
    expect(panel).toMatch(/if \(id === "blank"\) return;\n\s+const write = \(to: string \| null\) => window\.history\.replaceState\(null, "", promptLink\(window\.location\.href, to\)\);\n\s+write\(id\);\n\s+return \(\) => write\(null\);\n\s+\}, \[id\]\);/);
  });

  it("the feed opens the linked prompt on arrival, reads it once, and forgets it on close", () => {
    const feed = src("enki", "EnkiFeedPage.tsx");
    expect(feed).toContain("const [linked, setLinked] = useState<string | null>(() => linkedPrompt(searchParams));");
    expect(feed).toContain("const seed = open ? seedFromFeedCard(open) : linked ? { promptId: linked } : null;");
    expect(feed).toMatch(/setOpen\(null\);\n\s+setLinked\(null\);/);
    expect(feed).toMatch(/\{seed && \(\n\s+<EnkiDetailPanel seed=\{seed\} onClose=\{closeCard\} \/>/);
  });
});
