import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * /api/prompt must write the columns the live prompts table actually has.
 *
 * The route was written against a schema that no longer exists: user_id,
 * price, iv, auth_tag, uploaded_photos, downloads, rating. Every one of them
 * is a PostgREST 400 on the live table (probed 2026-08-11), which made every
 * save from the editor fail with PGRST204 — and the ownership filter
 * .in("user_id", ...) on the update branch matched nothing, so re-saves
 * 404'd silently. The bare `variables` table is a 404 too; the live one is
 * prompt_variables.
 *
 * This scans the route source the same way content-routes-moderated.test.ts
 * does: the dead column names must never come back as prompts-write keys,
 * and the live ones (creator_id, price_usd_cents, encrypted_content_kid)
 * must be present. A revert of the retarget turns this file red.
 */

const ROOT = join(__dirname, "..", "..");
const ROUTE = join(ROOT, "app", "api", "prompt", "route.ts");

const src = readFileSync(ROUTE, "utf8");

/** The one object literal both branches write to prompts. */
function promptRowBlock(): string {
  const m = src.match(/const promptRow = \{([\s\S]*?)\n\s*\};/);
  expect(m, "promptRow literal not found — the scan has nothing to check").not.toBeNull();
  return m![1];
}

/** The insert-branch payload spread on top of promptRow. */
function insertBlock(): string {
  const m = src.match(/\.from\("prompts"\)\s*\.insert\(\{([\s\S]*?)\}\)/);
  expect(m, "prompts insert payload not found").not.toBeNull();
  return m![1];
}

/** The column list GET selects from prompts. */
function promptSelect(): string {
  // The GET handler's read; the save path has its own ownership lookup.
  const m = src.slice(src.indexOf("export async function GET")).match(/\.from\("prompts"\)\s*\.select\(\s*"([^"]+)"/);
  expect(m, "prompts select list not found").not.toBeNull();
  return m![1];
}

/** The rows written to prompt_variables. */
function variableRowsBlock(): string {
  const m = src.match(/const variableRows = vars\.map\(([\s\S]*?)\n\s*\}\);/);
  expect(m, "variableRows literal not found").not.toBeNull();
  return m![1];
}

describe("/api/prompt writes only live prompts columns", () => {
  it("never uses a dead column as a prompts-write key", () => {
    const written = promptRowBlock() + insertBlock();
    // Anchored as object keys: `price:` must not match `price_usd_cents:`,
    // `iv:` must not match `encrypted_content_iv:`.
    for (const dead of ["user_id", "price", "iv", "auth_tag", "uploaded_photos", "downloads", "rating"]) {
      expect(written, `dead column '${dead}' is written to prompts again`).not.toMatch(
        new RegExp(`^\\s*${dead}:`, "m")
      );
    }
  });

  it("writes the live creator/price/kid columns", () => {
    const written = promptRowBlock() + insertBlock();
    expect(written).toMatch(/^\s*price_usd_cents:/m);
    expect(written).toMatch(/^\s*encrypted_content_kid:/m);
    expect(written).toMatch(/^\s*encrypted_content_iv:/m);
    expect(written).toMatch(/^\s*encrypted_content_tag:/m);
    expect(written).toMatch(/^\s*showcase_images:/m);
    expect(insertBlock()).toMatch(/^\s*creator_id:/m);
  });

  it("converts the body's dollars to integer cents at the boundary", () => {
    expect(src).toMatch(/Math\.round\(body\.price \* 100\)/);
  });

  it("scopes the ownership filter to creator_id, never the dead user_id", () => {
    // An UPDATE keyed on a column that does not exist matches nothing and
    // reports "not found" for every prompt, including your own.
    expect(src).toMatch(/\.in\("creator_id"/);
    expect(src).not.toMatch(/\.in\("user_id"/);
  });

  it("selects live columns on GET", () => {
    const sel = promptSelect();
    for (const col of ["creator_id", "price_usd_cents", "encrypted_content_kid", "showcase_images"]) {
      expect(sel, `GET no longer selects '${col}'`).toContain(col);
    }
    // \bprice\b cannot match inside price_usd_cents (underscore is a word
    // character), so this catches only the dead bare column.
    for (const dead of [/\buser_id\b/, /\bprice\b(?!_usd)/, /\biv\b/, /\bauth_tag\b/, /\buploaded_photos\b/]) {
      expect(sel, `GET selects a dead column: ${dead}`).not.toMatch(dead);
    }
  });

  it("uses lib/crypto's keyring, not hand-rolled cipher calls", () => {
    expect(src).toMatch(/from "@\/lib\/crypto"/);
    expect(src, "route rolls its own cipher again").not.toMatch(/createCipheriv|createDecipheriv/);
  });
});

describe("/api/prompt writes only live prompt_variables columns", () => {
  it("targets prompt_variables, never the nonexistent variables table", () => {
    expect(src).toMatch(/\.from\("prompt_variables"\)/);
    expect(src, "the bare `variables` table is a PostgREST 404").not.toMatch(/\.from\("variables"\)/);
  });

  it("writes the live enum/constraint columns, not the client field names", () => {
    const rows = variableRowsBlock();
    expect(rows).toMatch(/^\s*data_type:/m);
    expect(rows).toMatch(/^\s*is_required:/m);
    expect(rows).toMatch(/^\s*min_value:/m);
    expect(rows).toMatch(/^\s*max_value:/m);
    for (const dead of ["type", "required", "min", "max"]) {
      expect(rows, `client-shaped key '${dead}:' written to prompt_variables`).not.toMatch(
        new RegExp(`^\\s*${dead}:`, "m")
      );
    }
  });

  it("maps the client variable types onto the live enum labels", () => {
    // variable_data_type has no 'image'/'multi-select'/'single-select'
    // labels; unmapped they are enum errors that fail the whole save.
    expect(src).toContain('"reference_image"');
    expect(src).toContain('"multi_select"');
    expect(src).toContain('"single_select"');
  });
});

/*
 * The three prompt READ routes were written against the same dead schema
 * (user_id / price / uploaded_photos / downloads / rating and the bare
 * `variables` table, all re-probed 2026-08-12). A dead column inside a
 * select() string is a PostgREST 400 that fails the WHOLE select — the
 * showcase answered { items: [] } forever — and a dead column in a filter or
 * order() does the same to the marketplace feed. These scans hold that
 * boundary the same way the write scans above do.
 */
const READ_ROUTES = {
  "app/api/prompts/route.ts": readFileSync(
    join(ROOT, "app", "api", "prompts", "route.ts"), "utf8"),
  // The marketplace select list and card mapping moved to
  // lib/marketplace/card.ts (shared with /api/search, 2026-09-24); the
  // boundary is scanned across both files.
  "app/api/marketplace/prompts/route.ts": readFileSync(
    join(ROOT, "app", "api", "marketplace", "prompts", "route.ts"), "utf8")
    + readFileSync(join(ROOT, "lib", "marketplace", "card.ts"), "utf8"),
  "app/api/prompts/[id]/route.ts": readFileSync(
    join(ROOT, "app", "api", "prompts", "[id]", "route.ts"), "utf8"),
} as const;

/** The column list a route selects from prompts (inline, or the shared card constant). */
function promptsSelectOf(routeSrc: string): string {
  const m = routeSrc.match(/\.from\("prompts"\)\s*\.select\(\s*"([^"]+)"/)
    ?? routeSrc.match(/PROMPT_CARD_SELECT =\s*"([^"]+)"/);
  expect(m, "prompts select list not found — the scan has nothing to check").not.toBeNull();
  return m![1];
}

describe.each(Object.entries(READ_ROUTES))("%s reads only live columns", (_name, routeSrc) => {
  it("selects the live creator/price/images columns, never dead ones", () => {
    const sel = promptsSelectOf(routeSrc);
    for (const col of ["creator_id", "price_usd_cents", "showcase_images"]) {
      expect(sel, `select no longer carries '${col}'`).toContain(col);
    }
    // \bprice\b cannot match inside price_usd_cents and \biv\b cannot match
    // inside encrypted_content_iv (underscore is a word character), so these
    // catch only the dead bare columns.
    for (const dead of [/\buser_id\b/, /\bprice\b/, /\buploaded_photos\b/, /\bdownloads\b/, /\brating\b/, /\biv\b/, /\bauth_tag\b/]) {
      expect(sel, `select carries a dead column: ${dead}`).not.toMatch(dead);
    }
  });

  it("reads variables from prompt_variables (soft-delete aware), never `variables`", () => {
    expect(routeSrc).toMatch(/\.from\("prompt_variables"\)/);
    expect(routeSrc, "the bare `variables` table is a PostgREST 404").not.toMatch(/\.from\("variables"\)/);
    expect(routeSrc, "soft-deleted variables must stay invisible").toMatch(/\.is\("deleted_at", null\)/);
  });

  it("never filters, orders or scopes on a dead column", () => {
    // A dead column in eq/order is a 400 that kills the whole query, and the
    // old .in("user_id", …) ownership scope made every PATCH a 500.
    expect(routeSrc).not.toMatch(/\.(eq|gt|gte|lte|in|order)\("(price|downloads|rating|user_id|uploaded_photos)"/);
  });
});

describe("read routes serve the price unit their consumers print", () => {
  it("/api/prompts and /api/prompts/[id] convert stored cents to dollars", () => {
    // ArtworkGrid prints `${price}cr` and PromptGeneratorView prints
    // boostedCost(price).toFixed(2) — both raw, no client-side /100. Serving
    // cents under `price` would 100x every displayed price.
    expect(READ_ROUTES["app/api/prompts/route.ts"]).toMatch(/p\.price_usd_cents \/ 100/);
    expect(READ_ROUTES["app/api/prompts/[id]/route.ts"]).toMatch(/prompt\.price_usd_cents \/ 100/);
  });

  it("/api/marketplace/prompts keeps integer cents under the priceUsdCents name", () => {
    // The feed adapter (enkiPromptAdapter.dollars) divides by 100 itself;
    // pre-dividing here would shrink every feed price 100x.
    const src = READ_ROUTES["app/api/marketplace/prompts/route.ts"];
    expect(src).toMatch(/priceUsdCents:\s*[\s\S]{0,160}?p\.price_usd_cents/);
    expect(src).not.toMatch(/price_usd_cents \/ 100/);
  });
});

describe("/api/prompts/[id] specifics", () => {
  const src = READ_ROUTES["app/api/prompts/[id]/route.ts"];

  it("decrypts through lib/crypto's keyring, not the retired backend/encryption pair", () => {
    // The old pair read prompt.content/iv/auth_tag — all dead — so free
    // prompts never decrypted; lib/crypto owns the kid-carrying keyring.
    expect(src).toMatch(/decryptString/);
    expect(src).toMatch(/from "@\/lib\/crypto"/);
    expect(src).not.toMatch(/backend\/encryption/);
  });

  it("scopes PATCH ownership to creator_id of the resolved owners", () => {
    // creator_id is a users.id uuid: the session is resolved to its owners
    // the way a save resolves them, never used as an address.
    expect(src).toMatch(/const ids = await resolveOwnerIds\(supabase, req\.headers\.get\("X-Session-Token"\)\);/);
    expect(src).toMatch(/\.eq\("id", id\)\s*\.in\("creator_id", owners\);/);
  });
});
