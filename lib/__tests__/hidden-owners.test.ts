import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { fakePostgrest } from "./_fake-postgrest";
import { hiddenOwners } from "@/lib/hidden-owners";

/**
 * "A ban locks the marketplace, never the wallet" (BAN). A ban already stops
 * the session; a banned or deleted account's prompts, images and profile also
 * leave every public read, and its prompts are not sold (2026-10-08).
 */

const later = new Date(Date.now() + 86_400_000).toISOString();
const earlier = new Date(Date.now() - 86_400_000).toISOString();
let db: ReturnType<typeof fakePostgrest>;

beforeEach(() => {
  db = fakePostgrest();
  db.tables.users = [
    { id: "ok", deleted_at: null, account_status: "active" },
    // Deletion stamps deleted_at; either mark alone hides the account.
    { id: "deleted", deleted_at: earlier, account_status: "active" },
    { id: "legacy", deleted_at: null, account_status: null },
    { id: "suspended", deleted_at: null, account_status: "suspended" },
    { id: "banned", deleted_at: null, account_status: "active" },
    { id: "until", deleted_at: null, account_status: "active" },
    { id: "lifted", deleted_at: null, account_status: "active" },
    { id: "expired", deleted_at: null, account_status: "active" },
  ];
  db.tables.bans = [
    { user_id: "banned", lifted_at: null, expires_at: null },
    { user_id: "until", lifted_at: null, expires_at: later },
    { user_id: "lifted", lifted_at: earlier, expires_at: null },
    { user_id: "expired", lifted_at: null, expires_at: earlier },
  ];
});

const ALL = ["ok", "deleted", "legacy", "suspended", "banned", "until", "lifted", "expired", "unknown"];

describe("hiddenOwners", () => {
  it("hides a deleted or inactive account and an active ban, never a lifted or expired one", async () => {
    expect([...(await hiddenOwners(db.client as never, ALL))!].sort()).toEqual(["banned", "deleted", "suspended", "until"]);
  });

  it("asks nothing for nobody", async () => {
    db.state.failNext = { table: "users", op: "select", code: "PGRST000" };
    expect(await hiddenOwners(db.client as never, ["", ""])).toEqual(new Set());
  });

  it("answers null when the accounts or the bans cannot be read", async () => {
    db.state.failNext = { table: "users", op: "select", code: "PGRST000" };
    expect(await hiddenOwners(db.client as never, ALL)).toBeNull();
    db.state.failNext = { table: "bans", op: "select", code: "PGRST000" };
    expect(await hiddenOwners(db.client as never, ALL)).toBeNull();
  });
});

describe("every public read and the sell path", () => {
  const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

  it("the paid quote (human rails and x402) refuses a hidden creator's prompt", () => {
    const quote = src("lib", "payments", "generation-quote.ts");
    expect(quote).toContain('const hidden = await hiddenOwners(supabase, [String(data.creator_id ?? "")]);');
    expect(quote).toContain('if (!hidden) return { ok: false, status: 500, error: "Failed to load prompt" };');
    expect(quote).toContain('if (hidden.has(String(data.creator_id))) return { ok: false, status: 404, error: "Prompt not found" };');
  });

  it("the feed and search leave a hidden creator's prompts out", () => {
    const card = src("lib", "marketplace", "card.ts");
    expect(card).toContain('const hidden = await hiddenOwners(supabase, prompts.map((p) => String(p.userId ?? "")));');
    expect(card).toContain('if (!hidden) throw new Error("creators could not be read");');
    expect(card).toContain("prompts.filter((p) => !hidden.has(String(p.userId))).map(async (prompt) => {");
  });

  it("a profile's gallery, one image, the profile and the prompt page answer like nothing is there", () => {
    const gallery = src("app", "api", "generations", "route.ts");
    expect(gallery).toMatch(/if \(v\.userId !== ownerId\) \{\n\s+const hidden = await hiddenOwners\(supabase, \[ownerId\]\);\n\s+if \(!hidden\) return createErrorResponse\("Gallery unavailable", 503\);\n\s+if \(hidden\.has\(ownerId\)\) return createSuccessResponse\(\{ generations: \[\], total: 0, limit, offset \}\);/);
    const image = src("app", "api", "images", "[id]", "route.ts");
    expect(image).toContain('if (hidden.has(String(data.user_id))) return NextResponse.json({ error: "Image not found" }, { status: 404 });');
    expect(image).toContain(".select(\"id, user_id, storage_url, preview_url, thumbnail_url, width, height, prompt_id, created_at\")");
    const profile = src("app", "api", "creators", "[id]", "profile", "route.ts");
    expect(profile).toMatch(/if \(hidden\.has\(String\(userData\.id\)\)\) \{\n\s+return NextResponse\.json\(\{ success: false, error: "Creator not found" \}, \{ status: 404 \}\);/);
    const detail = src("app", "api", "prompts", "[id]", "route.ts");
    expect(detail).toMatch(/if \(!isOwner\) \{\n\s+const hidden = await hiddenOwners\(supabase, \[String\(prompt\.creator_id \?\? ""\)\]\);\n\s+if \(!hidden\) return dbUnavailableResponse\(\);\n\s+if \(hidden\.has\(String\(prompt\.creator_id\)\)\) return NextResponse\.json\(\{ error: "not found" \}, \{ status: 404 \}\);/);
  });

  it("the feed pages on the rows it read, so a hidden card never ends it", () => {
    const feed = src("app", "api", "marketplace", "prompts", "route.ts");
    expect(feed).toContain("const hasMore = prompts.length === limit;");
  });

  it("a link preview of a hidden creator's prompt is the brand card, title and words included", () => {
    const head = src("app", "generator", "[id]", "page.tsx");
    expect(head).toContain('.select("title, description, is_free_showcase, price_usd_cents, is_listed, listing_status, deleted_at, creator_id")');
    expect(head).toContain("if (p?.title && isListed(p) && hidden && !hidden.has(String(p.creator_id))) {");
  });

  it("the board's podium shows no render of a hidden account, and none when that cannot be read", () => {
    const board = src("app", "api", "leaderboard", "route.ts");
    expect(board).toContain('supabase.from("generated_images").select("prompt_id, user_id, thumbnail_url, storage_url, created_at")');
    expect(board).toContain("for (const g of renderOwners ? renders.filter((g) => !renderOwners.has(String(g.user_id))) : []) {");
  });

  it("the board, the link preview and 'Made with this prompt' leave them out", () => {
    const board = src("app", "api", "leaderboard", "route.ts");
    expect(board).toContain("const raw = all.filter((r) => !offBoard.has(String(r.creator_id)));");
    expect(board).toContain("if (!offBoard) return NextResponse.json({ rows: [] });");
    const og = src("app", "api", "og", "[id]", "route.tsx");
    expect(og).toContain("if (!hidden || hidden.has(String(p.creator_id))) p = null;");
    const row = src("app", "api", "prompts", "[id]", "images", "route.ts");
    expect(row).toContain("images: (data ?? []).filter((r) => !hidden.has(String(r.user_id))).map((r) => ({");
    // The shared fake returns whole rows; PostgREST returns only what is selected.
    expect(row).toContain('.select("id, user_id, storage_url, preview_url, thumbnail_url, created_at")');
  });
});
