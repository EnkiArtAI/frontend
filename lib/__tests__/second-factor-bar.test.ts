import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The red bar (Kev, 2026-10-07): 2FA stays optional, but every signed-in
 * account without a second factor sees a permanent bar at the top, without a
 * close button. An outage never reads as "no 2FA", and an email account is
 * never offered its own inbox as a factor.
 */

vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({}) }));
import { fetchStepUpFactors, missingSecondFactor } from "@/hooks/useSecondFactor";

const ROOT = join(__dirname, "..", "..");
const BAR = readSource(join(ROOT, "components", "SecondFactorBar.tsx"));
const CODES = readSource(join(ROOT, "components", "settings", "CodeFactors.tsx"));
const GATE = readSource(join(ROOT, "components", "BetaGate.tsx"));
const HOOK = readSource(join(ROOT, "hooks", "useSecondFactor.ts"));
const css = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");

describe("the red bar", () => {
  it("shows for a signed-in account without a factor, and for no one else", () => {
    expect(missingSecondFactor(true, { factors: [] })).toBe(true);
    expect(missingSecondFactor(true, { factors: ["totp"] })).toBe(false);
    expect(missingSecondFactor(true, undefined)).toBe(false);
    expect(missingSecondFactor(false, { factors: [] })).toBe(false);
  });

  it("never takes a failed read for \"no 2FA\"", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await expect(fetchStepUpFactors()).rejects.toThrow(/security settings/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ factors: ["passkey"], emailCodes: true }))));
    await expect(fetchStepUpFactors()).resolves.toEqual({ factors: ["passkey"], emailCodes: true });
  });

  it("cannot be closed, stays off public pages and /banned, and moves the page down", () => {
    expect(BAR).not.toMatch(/aria-label="Close"|onClose|dismiss|×|✕/);
    expect(BAR).toMatch(/!PUBLIC_PATHS\.has\(pathname\) && !pathname\.startsWith\("\/banned"\)/);
    expect(BAR).toMatch(/setProperty\("--ek-banner-h", "30px"\)/);
  });

  it("offers no email code to an account whose email is its login", () => {
    expect(CODES).toMatch(/\{data\?\.emailCodes && row\("email",/);
  });

  it("is a plain button for screen readers, not a status region", () => {
    expect(BAR).toMatch(/<button\s+type="button"/);
    expect(BAR).not.toMatch(/role=/);
  });
});

describe("the 2FA state behind the bar", () => {
  it("is read afresh for a new session only: re-checks of the same one keep it, so the bar never blinks", () => {
    expect(GATE).toMatch(/if \(headers\["X-Session-Token"\] !== checkedSession\.current\) \{\s*checkedSession\.current = headers\["X-Session-Token"\];\s*queryClient\.removeQueries\(\{ queryKey: \["stepup-factors"\] \}\);\s*\}/);
    expect(GATE.match(/removeQueries/g)).toHaveLength(1);
  });

  it("is read again when the tab comes back, so a factor set up elsewhere shows at once", () => {
    expect(HOOK).toMatch(/useQuery\(\{ queryKey: STEPUP_FACTORS_KEY, enabled, retry: 2, refetchOnWindowFocus: "always", queryFn: fetchStepUpFactors \}\)/);
  });
});

describe("the page under the bar", () => {
  it("starts below it outside the shell; the shell moves its own layers", () => {
    expect(BAR).toMatch(/root\.classList\.add\("ek-2fa-bar"\)/);
    expect(BAR).toMatch(/root\.classList\.remove\("ek-2fa-bar"\)/);
    expect(css("app", "globals.css")).toMatch(/\nhtml\.ek-2fa-bar:not\(\.ek-in-shell\) body \{ padding-top: var\(--ek-banner-h\); \}/);
    const shell = readSource(join(ROOT, "components", "enki-shell", "EnkiHome.tsx"));
    expect(shell).toMatch(/useEffect\(\(\) => \{\s*document\.documentElement\.classList\.add\("ek-in-shell"\);\s*return \(\) => document\.documentElement\.classList\.remove\("ek-in-shell"\);\s*\}, \[\]\);/);
    // Turbopack's dev build drops :has() from a selector: the rule must not need it.
    expect(css("app", "globals.css")).not.toMatch(/ek-2fa-bar[^{]*:has\(/);
    // .ek-app pages outside the shell (admin) must inherit the bar's height.
    expect(css("components", "enki-shell", "enki-shell.css")).not.toMatch(/\.ek-app \{ --ek-banner-h: 0px; \}/);
  });

  it("keeps full-height pages and fixed layers out from under it", () => {
    const pgv = css("components", "prompt-generator.css");
    expect(pgv).toMatch(/\.pgv-page \{\s*display: flex;\s*height: calc\(100vh - var\(--ek-banner-h, 0px\)\);/);
    const history = [...pgv.matchAll(/\.pgv-history(-handle)? \{([^}]*)\}/g)].filter((m) => /\btop:/.test(m[2]));
    expect(history).toHaveLength(4);
    for (const m of history) expect(m[2]).toMatch(/top: (calc\(12px \+ )?var\(--ek-banner-h, 0px\)/);
    expect(readSource(join(ROOT, "app", "editor", "page.tsx"))).toMatch(/position: "fixed", inset: "var\(--ek-banner-h, 0px\) 0 0 0"/);
    expect(readSource(join(ROOT, "app", "admin", "page.tsx"))).not.toMatch(/height: "100vh"/);
  });
});
