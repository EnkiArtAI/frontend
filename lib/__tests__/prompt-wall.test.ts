import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Likes and bookmarks show prompts exactly like Home (Kev, 2026-10-13: "the
 * same view like on home"): one PromptWall, fed by the marketplace's ?ids=
 * read, opening the image view beside the menu. A click on a history image
 * loads what it was made with (GET /api/generations carries the settings).
 */
const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

describe("the marketplace answers exactly the asked prompts", () => {
  const route = src("app", "api", "marketplace", "prompts", "route.ts");

  it("takes ?ids= as uuids only, each once, at most `limit`, and answers nothing for a list without one", () => {
    expect(route).toContain('const askedIds = searchParams.getAll("ids");');
    expect(route).toContain("const ids = [...new Set(askedIds.filter((id) => UUID.test(id)))].slice(0, limit);");
    expect(route).toContain('dbQuery = dbQuery.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);');
  });

  it("keeps the listing, 18+ and hidden-creator rules on an ids read (the filter sits inside the same query)", () => {
    const at = route.indexOf("const askedIds");
    expect(at).toBeGreaterThan(route.indexOf('dbQuery = dbQuery.eq("is_listed", true).eq("listing_status", "active").is("deleted_at", null);'));
    expect(at).toBeLessThan(route.indexOf("dbQuery = hideAdult(dbQuery, await viewer(supabase, request), creatorId);"));
  });
});

describe("the wall", () => {
  const wall = src("components", "enki", "PromptWall.tsx");

  it("reads cards by id in chunks of 50 through the feed's own mapping, in the caller's order", () => {
    expect(wall).toContain("const CHUNK = 50;");
    expect(wall).toContain('for (const id of ids.slice(i, i + CHUNK)) q.append("ids", id);');
    expect(wall).toContain("const card = toFeedCard(raw);");
    expect(wall).toContain("return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));");
  });

  it("is the feed's grid and cards, and opens the image view beside the menu", () => {
    expect(wall).toContain("<MasonryGrid items={items} skeletons={pending ? 6 : 0} renderItem={(card) => (");
    expect(wall).toContain("<FeedCard card={card} onOpen={setOpen} canBookmark={authed} saved={index?.get(card.id)} />");
    expect(wall).toContain("{open && <EnkiDetailPanel seed={seedFromFeedCard(open)} onClose={() => setOpen(null)} />}");
  });

  it("is what the Likes tab and a bookmark category show", () => {
    const profile = src("components", "profile", "ProfileView.tsx");
    expect(profile).toContain("<PromptWall ids={(myLikes ?? []).map((l) => l.promptId)} loading={myLikes === null}");
    expect(profile).not.toMatch(/router\.push\(`\/generator\/\$\{l\.promptId\}`\)/);
    const bookmarks = src("components", "enki-shell", "BookmarksPanel.tsx");
    expect(bookmarks).toContain("<PromptWall ids={ids} loading={loading && marks.length === 0} more={!done} onMore={more}");
    // A bookmark the card's own button took out of the category leaves the wall at once.
    expect(bookmarks).toContain(".filter((m) => !index || (index.get(m.promptId) ?? []).some((x) => x.categoryId === open?.id))");
    expect(bookmarks).not.toMatch(/onDragStart|router\.push|enki-bm-item/);
  });
});

