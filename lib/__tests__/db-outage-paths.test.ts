import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { fakePostgrest } from "./_fake-postgrest";
import { DbUnreachableError, DB_UNAVAILABLE_MESSAGE, dbOutage, refusalBody } from "@/lib/db-error";
import { hiddenOwners } from "@/lib/hidden-owners";
import { resolveModel, resolveModelByFamily } from "@/lib/generation/models";
import { resolvePaidSettings } from "@/lib/payments/generation-settings";
import { loadPromptText } from "@/lib/generation/prompt-text";
import { checkAgentPromptInputs } from "@/lib/generation/agent-prompt-inputs";

/**
 * A database that cannot be reached is an outage (Kev, 2026-09-05): 503
 * DB_UNAVAILABLE, never "unknown model", "prompt not found", "failed to load"
 * or "sign in". Here every helper the paid rails and the hidden-owner reads
 * lean on; a refusal that is not an outage keeps its own answer.
 */

const OUTAGE = { ok: false, status: 503, error: DB_UNAVAILABLE_MESSAGE, code: "DB_UNAVAILABLE" };
const DEAD = "ECONNREFUSED"; // a code isDbUnreachable reads as a dead host
const MODEL = "aaaaaaaa-0000-4000-8000-0000000000aa";
let db: ReturnType<typeof fakePostgrest>;

beforeEach(() => {
  db = fakePostgrest();
  db.tables.models = [{ id: MODEL, name: "Nano Banana Pro", active: true, allowed_ratios: null, max_reference_images: 4, model_providers: [] }];
  db.tables.users = [];
  db.tables.bans = [];
});
const fail = (table: string, code: string) => { db.state.failNext = { table, op: "select", code }; };

describe("hiddenOwners", () => {
  it("throws an outage, so every reader answers it as one", async () => {
    fail("bans", DEAD);
    await expect(hiddenOwners(db.client as never, ["u1"])).rejects.toBeInstanceOf(DbUnreachableError);
    fail("users", DEAD);
    await expect(hiddenOwners(db.client as never, ["u1"])).rejects.toBeInstanceOf(DbUnreachableError);
  });

  it("answers any other failure with null, as before", async () => {
    fail("bans", "PGRST000");
    expect(await hiddenOwners(db.client as never, ["u1"])).toBeNull();
  });
});

describe("the model lookups", () => {
  it("throw an outage instead of answering 'no such model'", async () => {
    fail("models", DEAD);
    await expect(resolveModel(db.client as never, [MODEL])).rejects.toBeInstanceOf(DbUnreachableError);
    fail("models", DEAD);
    await expect(resolveModelByFamily(db.client as never, "nano-banana-pro")).rejects.toBeInstanceOf(DbUnreachableError);
  });

  it("still fall back to the plain select when only the embed fails", async () => {
    fail("models", "PGRST200");
    expect((await resolveModel(db.client as never, [MODEL]))?.id).toBe(MODEL);
  });

  it("an outage in that fallback select is an outage too", async () => {
    db.state.failNext = { table: "models", op: "select", code: "PGRST200" };
    const first = resolveModel(db.client as never, [MODEL]);
    // The embed fails on its own; the fallback then meets a dead host.
    db.state.failing = { table: "models", code: DEAD };
    await expect(first).rejects.toBeInstanceOf(DbUnreachableError);
  });
});

describe("the helpers that answer with results", () => {
  it("the paid settings answer an outage with 503 and its code", async () => {
    fail("models", DEAD);
    expect(await resolvePaidSettings(db.client as never, { modelId: MODEL, resolution: "1K" } as never)).toEqual(OUTAGE);
  });

  it("the artist's text answers an outage with 503, another failure with 500", async () => {
    fail("prompts", DEAD);
    expect(await loadPromptText(db.client as never, "p1")).toEqual(OUTAGE);
    fail("prompts", "PGRST000");
    expect(await loadPromptText(db.client as never, "p1")).toMatchObject({ ok: false, status: 500 });
  });

  it("an agent's inputs answer an outage with 503 on either read", async () => {
    fail("prompts", DEAD);
    expect(await checkAgentPromptInputs(db.client as never, "p1", {})).toEqual(OUTAGE);
    db.tables.prompts = [{ id: "p1", prompt_type: "paid", is_free_showcase: false, is_listed: true, listing_status: "active", deleted_at: null }];
    fail("prompt_variables", DEAD);
    expect(await checkAgentPromptInputs(db.client as never, "p1", {})).toEqual(OUTAGE);
  });
});

describe("every route passes the outage on", () => {
  it("a refusal body carries the outage code, and only an outage's", () => {
    expect(refusalBody(dbOutage())).toEqual({ error: DB_UNAVAILABLE_MESSAGE, code: "DB_UNAVAILABLE" });
    expect(refusalBody({ error: "Prompt not found" })).toEqual({ error: "Prompt not found" });
  });

  const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

  it("the paid rails hand the helper's 503 and code to the caller", () => {
    const intent = src("app", "api", "payments", "generation", "intent", "route.ts");
    expect(intent).toContain("if (!resolved.ok) return NextResponse.json(refusalBody(resolved), { status: resolved.status });");
    expect(intent).toContain("return NextResponse.json(refusalBody(quote), { status: quote.status });");
    const quote = src("app", "api", "payments", "generation", "quote", "route.ts");
    expect(quote).toContain("if (!resolved.ok) return { status: resolved.status, body: refusalBody(resolved) };");
    expect(quote).toContain("if (!quote.ok) return { status: quote.status, body: refusalBody(quote) };");
    const x402 = src("app", "api", "x402", "generate", "route.ts");
    expect(x402).toContain("if (!filled.ok) return { status: filled.status, body: refusalBody(filled) };");
    expect(x402).toContain("if (!quote.ok) return { status: quote.status, body: refusalBody(quote) };");
    expect(x402).toContain("if (!inputs.ok) return inputs;");
    expect(x402).toMatch(/model = await resolveModelByFamily\(supabase, input\.modelFamily\);\n\s+\} catch \(e\) \{\n\s+if \(isDbUnreachable\(e\)\) return dbUnavailableResponse\(\);/);
    expect(src("app", "api", "generate-image", "route.ts")).toContain("if (!text.ok) return NextResponse.json(refusalBody(text), { status: text.status });");
  });

  it("a save that cannot check the payout wallet says so, never 'connect a wallet'", () => {
    expect(src("app", "api", "prompt", "route.ts")).toContain("return payout.status === 422");
  });

  it("the hidden-owner readers answer an outage with 503 where they answer errors at all", () => {
    for (const p of [["creators", "[id]", "profile"], ["generations"], ["prompts"], ["prompts", "[id]"]]) {
      expect(src("app", "api", ...p, "route.ts"), p.join("/")).toMatch(/\} catch \((e|error)(: unknown)?\) \{\n\s+if \(isDbUnreachable\((e|error)\)\) return dbUnavailableResponse\(\);/);
    }
  });

  it("the board answers an outage with 503, never an empty board", () => {
    const board = src("app", "api", "leaderboard", "route.ts");
    expect(board).toMatch(/export async function GET\(req: NextRequest\) \{\n\s+try \{\n\s+return await board\(req\);\n\s+\} catch \(e\) \{\n\s+if \(isDbUnreachable\(e\)\) return dbUnavailableResponse\(\);/);
    expect(board).toContain("  if (isDbUnreachable(error)) return dbUnavailableResponse();\n  if (error) return NextResponse.json({ rows: [] });");
  });

  it("a profile, the intent and the quote's owner check answer an outage as one", () => {
    expect(src("app", "api", "creators", "[id]", "profile", "route.ts")).toContain("    if (isDbUnreachable(userError)) return dbUnavailableResponse();\n    if (userError || !userData) {");
    expect(src("app", "api", "payments", "generation", "intent", "route.ts")).toContain("  if (isDbUnreachable(insertError)) return dbUnavailableResponse();\n  if (insertError || !intent) {");
  });

  it("a failed hidden-owner lookup that is no outage is a 500, never labelled DB_UNAVAILABLE", () => {
    expect(src("app", "api", "images", "[id]", "route.ts")).toContain('if (!hidden) return NextResponse.json({ error: "Could not load the image" }, { status: 500 });');
    expect(src("app", "api", "prompts", "[id]", "images", "route.ts")).toContain('if (!hidden) return NextResponse.json({ error: "Could not load the images" }, { status: 500 });');
    expect(src("app", "api", "prompts", "[id]", "route.ts")).toContain('if (!hidden) return NextResponse.json({ error: "Could not load the prompt" }, { status: 500 });');
    expect(src("app", "api", "creators", "[id]", "profile", "route.ts")).toContain('if (!hidden) return NextResponse.json({ success: false, error: "Creator unavailable" }, { status: 500 });');
  });
});
