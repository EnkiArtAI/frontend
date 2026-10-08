import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { fakePostgrest } from "./_fake-postgrest";
import { freeRenderPrompt } from "@/lib/generation/free-render-prompt";

/**
 * The prompt a free render names (Kev, 2026-10-08): the free model renders
 * only the text the client sends, so someone else's paid prompt never renders
 * there, and a stranger can never put renders under another creator's prompt
 * (they would show in its public row "Made with this prompt").
 */

const LIVE = { is_listed: true, listing_status: "active", deleted_at: null };
const P = "aaaaaaaa-0000-4000-8000-000000000001";
let db: ReturnType<typeof fakePostgrest>;
const named = (row: Record<string, unknown> | null, caller = "buyer") => {
  db.tables.prompts = row ? [{ id: P, creator_id: "artist", is_adult: false, ...row }] : [];
  return freeRenderPrompt(db.client as never, P, [caller]);
};

beforeEach(() => { db = fakePostgrest(); });

describe("the prompt a free render names", () => {
  it("refuses someone else's paid prompt on sale", async () => {
    expect(await named({ ...LIVE, prompt_type: "paid" })).toEqual({ adult: false, paid: true, creditId: null });
  });

  it("credits someone else's free prompt on sale", async () => {
    expect(await named({ ...LIVE, prompt_type: "free" })).toEqual({ adult: false, paid: false, creditId: P });
    expect(await named({ ...LIVE, prompt_type: "paid", is_free_showcase: true })).toEqual({ adult: false, paid: false, creditId: P });
  });

  it("names nothing for someone else's prompt that is not on sale, free or paid, and refuses nothing", async () => {
    expect(await named({ is_listed: false, listing_status: "draft", prompt_type: "paid" })).toEqual({ adult: false, paid: false, creditId: null });
    expect(await named({ ...LIVE, deleted_at: "2026-10-08T00:00:00Z", prompt_type: "free" })).toEqual({ adult: false, paid: false, creditId: null });
  });

  it("credits the caller's own prompt, paid or a draft", async () => {
    expect(await named({ ...LIVE, prompt_type: "paid" }, "artist")).toEqual({ adult: false, paid: false, creditId: P });
    expect(await named({ is_listed: false, listing_status: "draft", prompt_type: "create-now" }, "artist")).toEqual({ adult: false, paid: false, creditId: P });
  });

  it("carries the 18+ mark, and names nothing for an unknown or absent id", async () => {
    expect((await named({ ...LIVE, prompt_type: "free", is_adult: true }))?.adult).toBe(true);
    expect(await named(null)).toEqual({ adult: false, paid: false, creditId: null });
    expect(await freeRenderPrompt(db.client as never, null, ["buyer"])).toEqual({ adult: false, paid: false, creditId: null });
  });

  it("answers null when the lookup fails", async () => {
    db.state.failNext = { table: "prompts", op: "select", code: "PGRST000" };
    expect(await named({ ...LIVE, prompt_type: "free" })).toBeNull();
  });
});

describe("the free route", () => {
  const FREE = readSource(join(__dirname, "..", "..", "app", "api", "generate-free", "route.ts"));

  it("refuses a paid prompt with 402 before the allowance is claimed, and refuses a failed lookup", () => {
    const refused = FREE.indexOf("if (named.paid) {");
    expect(refused).toBeGreaterThan(-1);
    expect(refused).toBeLessThan(FREE.indexOf("const decision = await freeGenerationDecision("));
    expect(FREE).toContain('return NextResponse.json({ error: "This prompt renders only on a paid model. Nothing was generated." }, { status: 402 });');
    expect(FREE).toMatch(/if \(named === null\) \{\n\s+return NextResponse\.json\(\{ error: "This prompt could not be checked right now\. Nothing was generated\." \}, \{ status: 503 \}\);/);
  });

  it("asks with the caller's own ids, records only the credited prompt, and keeps the 18+ mark", () => {
    expect(FREE).toContain('(await resolveOwnerIds(supabaseForChecks, request.headers.get("X-Session-Token"))) ?? [],');
    expect(FREE).toContain("promptId: named.creditId,");
    expect(FREE).toContain("const adult = (check.verdict === \"clear\" && check.adult === true) || named.adult;");
  });
});

describe("the pickers", () => {
  it("offer no free model on a paid prompt", () => {
    const view = readSource(join(__dirname, "..", "..", "components", "PromptGeneratorView.tsx"));
    expect(view).toContain("const generators = isFree ? GENERATORS : GENERATORS.filter((g) => !onFreeHost(g));");
    expect(view).toContain("{generators.map(g => <option key={g}>{g}</option>)}");
    expect(view).toContain('const generator = generatorPick || (!isFree && onFreeHost(promptModelName) ? "" : promptModelName);');
    const launcher = readSource(join(__dirname, "..", "..", "components", "GenerateLauncher.tsx"));
    expect(launcher).toContain("core.catalogue.filter((m) => !(locked && m.free))");
  });
});
