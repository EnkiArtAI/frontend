import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * 18+ content (Kev, 2026-10-03): a confirmed adult who turned the 18+ pill on
 * sees it; nobody else does. Generating 18+ needs the confirmation, which an
 * agent cannot give. Prompts and images are marked automatically.
 */

let confirmedAt: string | null;
let lookupFails = false;
const inserts: { table: string; row: Record<string, unknown> }[] = [];

function chain(table: string) {
  const q: Record<string, unknown> = {
    maybeSingle: async () => {
      if (lookupFails) throw new Error("db down");
      return { data: table === "users" ? { adult_confirmed_at: confirmedAt } : null, error: null };
    },
    insert: (row: Record<string, unknown>) => { inserts.push({ table, row }); return q; },
    single: async () => ({ data: { id: `${table}-1` }, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
  };
  for (const m of ["select", "eq", "is", "order", "limit"]) q[m] = () => q;
  return q;
}
const fake = { from: chain } as unknown as SupabaseClient;

vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async (_s: unknown, t: string | null) => (t === "tok" ? "user-1" : null) }));
vi.mock("@/lib/crypto", () => ({ encryptString: () => ({ encrypted: "ct", iv: "iv", authTag: "tag", kid: "k1" }) }));
vi.mock("@/lib/generation/derivative-store", () => ({ storeGeneratedImage: async (url: string) => ({ imageUrl: url, previewUrl: url, thumbnailUrl: null }) }));

import { adultConfirmed, promptMarkedAdult, viewer } from "@/lib/adult-content";
import { recordGeneration } from "@/lib/generation/record";
import { warningMessage } from "@/lib/moderation/warnings";

const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

beforeEach(() => {
  confirmedAt = null;
  lookupFails = false;
  inserts.length = 0;
});

describe("the age confirmation", () => {
  it("is false without an account", async () => {
    expect(await adultConfirmed(fake, null)).toBe(false);
  });

  it("is true once the user confirmed", async () => {
    confirmedAt = "2026-10-03T10:00:00Z";
    expect(await adultConfirmed(fake, "user-1")).toBe(true);
  });
});

describe("who may see 18+", () => {
  it("a confirmed adult with the pill on", async () => {
    confirmedAt = "2026-10-03T10:00:00Z";
    expect(await viewer(fake, req({ "X-Session-Token": "tok", "X-Show-Adult": "1" }))).toEqual({ userId: "user-1", showAdult: true });
  });

  it("not a confirmed adult with the pill off", async () => {
    confirmedAt = "2026-10-03T10:00:00Z";
    expect((await viewer(fake, req({ "X-Session-Token": "tok" }))).showAdult).toBe(false);
  });

  it("not someone who turned the pill on without confirming", async () => {
    expect((await viewer(fake, req({ "X-Session-Token": "tok", "X-Show-Adult": "1" }))).showAdult).toBe(false);
  });

  it("not an anonymous visitor who sends the header", async () => {
    expect(await viewer(fake, req({ "X-Show-Adult": "1" }))).toEqual({ userId: null, showAdult: false });
  });

  it("the safe view when the lookup fails", async () => {
    lookupFails = true;
    expect((await viewer(fake, req({ "X-Session-Token": "tok", "X-Show-Adult": "1" }))).showAdult).toBe(false);
  });
});

describe("recording marks 18+", () => {
  const rec = (adult: boolean) => recordGeneration(fake, {
    userId: "user-1", promptId: null, finalPrompt: "p", effectivePrompt: "p", variableValues: {},
    model: { id: "m1", name: "Model" } as never, route: { provider: "x", providerModel: "y" } as never,
    boost: false, aspectRatio: null, resolution: null, seed: null, output: null, generationMs: 1,
    imageUrl: "https://blob/img.png", adult,
  } as never);

  it("on the image", async () => {
    await rec(true);
    expect(inserts.find((i) => i.table === "generated_images")?.row.is_adult).toBe(true);
  });

  it("on the free-form prompt row", async () => {
    await rec(true);
    expect(inserts.find((i) => i.table === "prompts")?.row.is_adult).toBe(true);
  });

  it("not when the prompt check found nothing", async () => {
    await rec(false);
    expect(inserts.find((i) => i.table === "generated_images")?.row.is_adult).toBe(false);
  });
});

describe("a refused save", () => {
  it("says nothing was saved", () => {
    expect(warningMessage("explicit_sexual", { total: 1, suspendedUntil: null, nextStepAt: 10 }, "save")).toMatch(/^Explicit sexual content isn't allowed on Enki\. Nothing was saved\./);
  });
});

describe("the routes", () => {
  const ROOT = join(__dirname, "..", "..");
  const HUMAN = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
  const FREE = readSource(join(ROOT, "app", "api", "generate-free", "route.ts"));
  const AGENT = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));
  const SAVE = readSource(join(ROOT, "app", "api", "prompt", "route.ts"));

  it("refuse 18+ to an unconfirmed buyer before the charge", () => {
    const refuse = HUMAN.indexOf("return NextResponse.json(ADULT_REFUSAL, { status: 403 });");
    expect(HUMAN).toMatch(/const adult = \(check\.verdict === "clear" && check\.adult === true\) \|\| promptAdult;/);
    expect(refuse).toBeGreaterThan(-1);
    expect(HUMAN.indexOf("await claimForGeneration(")).toBeGreaterThan(refuse);
  });

  it("refuse 18+ on the free generator to anyone unconfirmed", () => {
    expect(FREE).toMatch(/const adult = \(check\.verdict === "clear" && check\.adult === true\)\n/);
    expect(FREE).toMatch(/if \(adult && !\(await adultConfirmed\(supabaseForChecks, await resolveRecordingUserId\(supabaseForChecks, request\)\)\)\) \{/);
  });

  it("never generate 18+ for an agent", () => {
    expect(AGENT).toMatch(/if \(\(check\.verdict === "clear" && check\.adult\) \|\| promptAdult\) return NextResponse\.json\(ADULT_REFUSAL, \{ status: 403 \}\);/);
  });

  it("let tier 2 defer to the prompt check only where it saw the whole text", () => {
    for (const src of [FREE, SAVE]) expect(src).toMatch(/adultJudged: true/);
    expect(HUMAN).toMatch(/moderate\(\{ prompt, surface: "generate-image", signal: request\.signal, adultJudged: !fromArtist \|\| promptAdult \}\)/);
    expect(AGENT).toMatch(/moderate\(\{ prompt: promptText, surface: "x402-generate", adultJudged: !input\.promptId \}\)/);
  });

  it("count a stored prompt's own 18+ mark on every path", () => {
    expect(HUMAN).toMatch(/\} else if \(paid\.prompt_id\) \{\n\s+promptAdult = await promptMarkedAdult\(getSupabaseServerClient\(\), paid\.prompt_id as string\);/);
    expect(FREE).toMatch(/\|\| \(await promptMarkedAdult\(supabaseForChecks, UUID_RE\.test\(String\(body\?\.promptId \?\? ""\)\) \? String\(body\.promptId\) : null\)\);/);
  });

  it("mark the images they record", () => {
    expect(HUMAN).toMatch(/recordGeneration\(recSupabase, \{\n\s+adult,/);
    expect(FREE).toMatch(/recordGeneration\(supabase, \{\n\s+adult,/);
  });

  it("check a prompt before saving it and mark it 18+ by itself", () => {
    const check = SAVE.indexOf("const check = await checkPrompt(judged, { hidden: false, signal: req.signal });");
    expect(check).toBeGreaterThan(-1);
    expect(SAVE.indexOf("const promptRow = {")).toBeGreaterThan(check);
    expect(SAVE).toMatch(/const adult = check\.adult === true \|\| \(await showsAdultRender\(supabase, uploadedPhotos\)\);/);
    expect(SAVE).toMatch(/const promptRow = \{\n\s+is_adult: adult,/);
  });

  it("refuse an explicit prompt with a warning, and save nothing unchecked", () => {
    expect(SAVE).toMatch(/warningMessage\(check\.verdict, outcome, "save"\)/);
    expect(SAVE).toMatch(/This prompt could not be checked right now\. Nothing was saved\./);
  });
});

describe("a stored prompt's own mark", () => {
  const prompts = (row: Record<string, unknown> | null) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
  }) as unknown as SupabaseClient;

  it("is read when the prompt is 18+", async () => {
    expect(await promptMarkedAdult(prompts({ is_adult: true }), "p1")).toBe(true);
  });

  it("is false for an ordinary or a missing prompt, and without an id", async () => {
    expect(await promptMarkedAdult(prompts({ is_adult: false }), "p1")).toBe(false);
    expect(await promptMarkedAdult(prompts(null), "p1")).toBe(false);
    expect(await promptMarkedAdult(prompts({ is_adult: true }), null)).toBe(false);
  });
});
