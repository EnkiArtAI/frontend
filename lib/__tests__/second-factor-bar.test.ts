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
  it("starts below it outside the shell, before paint; the shell moves its own layers", () => {
    expect(BAR).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(!show\) return;/);
    expect(BAR).toMatch(/root\.classList\.add\("ek-2fa-bar"\)/);
    expect(BAR).toMatch(/root\.classList\.remove\("ek-2fa-bar"\)/);
    const globals = css("app", "globals.css");
    expect(globals).toMatch(/\nhtml\.ek-2fa-bar:not\(\.ek-in-shell\) \{ --ek-page-top: var\(--ek-banner-h\); \}/);
    expect(globals).toMatch(/\nhtml\.ek-2fa-bar:not\(\.ek-in-shell\) body \{ padding-top: var\(--ek-page-top\); \}/);
    const shell = readSource(join(ROOT, "components", "enki-shell", "EnkiHome.tsx"));
    expect(shell).toMatch(/useLayoutEffect\(\(\) => \{\s*document\.documentElement\.classList\.add\("ek-in-shell"\);\s*return \(\) => document\.documentElement\.classList\.remove\("ek-in-shell"\);\s*\}, \[\]\);/);
    // Turbopack's dev build drops :has() from a selector: the rule must not need it.
    expect(globals).not.toMatch(/ek-2fa-bar[^{]*:has\(/);
    // .ek-app pages outside the shell (admin) must inherit the bar's height.
    expect(css("components", "enki-shell", "enki-shell.css")).not.toMatch(/\.ek-app \{ --ek-banner-h: 0px; \}/);
  });

  it("keeps full-height pages, fixed layers and sticky headers out from under it", () => {
    const pgv = css("components", "prompt-generator.css");
    expect(pgv).toMatch(/\.pgv-page \{\s*display: flex;\s*height: calc\(100vh - var\(--ek-banner-h, 0px\)\);/);
    // Every viewport height the generator page takes subtracts the bar, the phone override included.
    const pageHeights = [...pgv.matchAll(/\.pgv-page \{([^}]*)\}/g)].flatMap((m) => [...m[1].matchAll(/height: ([^;]*);/g)].map((h) => h[1]));
    const viewport = pageHeights.filter((h) => /\d+d?vh/.test(h));
    expect(viewport.length).toBeGreaterThanOrEqual(2);
    for (const h of viewport) expect(h).toMatch(/^calc\(100d?vh - var\(--ek-banner-h, 0px\)\)( !important)?$/);
    const history = [...pgv.matchAll(/\.pgv-history(-handle)? \{([^}]*)\}/g)].filter((m) => /\btop:/.test(m[2]));
    expect(history).toHaveLength(4);
    for (const m of history) expect(m[2]).toMatch(/top: (calc\(12px \+ )?var\(--ek-banner-h, 0px\)/);
    expect(readSource(join(ROOT, "app", "editor", "page.tsx"))).toMatch(/position: "fixed", inset: "var\(--ek-banner-h, 0px\) 0 0 0"/);
    // Admin: .ek-app's min-height: 100vh would beat the subtracted height.
    const admin = readSource(join(ROOT, "app", "admin", "page.tsx"));
    const roots = [...admin.matchAll(/className="ek-app" style=\{\{([^}]*)\}\}/g)].map((m) => m[1]);
    expect(roots).toHaveLength(3);
    for (const r of roots) expect(r).toMatch(/height: "calc\(100vh - var\(--ek-banner-h, 0px\)\)", minHeight: 0/);
    // The profile's sticky headers stop below the bar on its own page, at 0 inside the shell.
    const profile = readSource(join(ROOT, "components", "profile", "ProfileView.tsx"));
    expect(profile).toMatch(/position: "sticky", top: "var\(--ek-page-top, 0px\)"/);
    expect(profile).toMatch(/top: "calc\(52px \+ var\(--ek-page-top, 0px\)\)"/);
    expect(profile).not.toMatch(/position: "sticky", top: 0\b|top: 52\b/);
  });
});
