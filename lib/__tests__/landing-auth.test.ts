import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * The landing's login is real (Kev, 2026-10-07): email + password log in and
 * open the app at once. Sign-up is wired but closed in the private beta: the
 * access form takes applications; opened, it creates the account and falls
 * back to the application for an email not on the access list. The
 * page is static HTML, so this reads its script (the flows were also run in
 * a browser against the dev server).
 */

const LANDING = readFileSync(join(__dirname, "..", "..", "public", "landing.html"), "utf8");
const fn = (name: string) => {
  const start = LANDING.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return LANDING.slice(start, LANDING.indexOf("\n}\n", start));
};

describe("the landing login", () => {
  it("logs in with the password and opens the app with the session", () => {
    expect(fn("submitAuth")).toMatch(/postJson\('\/api\/auth\/password\/login', \{ identifier: email, password: /);
    expect(fn("submitAuth")).toMatch(/ok && data\.token \? adoptSession\(data\) : fail\(data\.error\)/);
    const adopt = fn("adoptSession");
    expect(adopt).toMatch(/localStorage\.setItem\('enki_session_token', d\.token\)/);
    expect(adopt).toMatch(/localStorage\.setItem\('enki_session_email', d\.email\)/);
    expect(adopt).toMatch(/localStorage\.removeItem\('solana-auth-session'\)/);
    expect(adopt).toMatch(/sessionStorage\.setItem\('enki:wallet-ask', '1'\)/);
    expect(adopt).toMatch(/location\.href = d\.banned \? '\/banned' : '\/home'/);
  });

  it("takes applications only during the private beta: sign-up is wired but closed", () => {
    expect(LANDING).toMatch(/const SIGNUP_OPEN = false;/);
    expect(LANDING).toMatch(/let signupStep = 'apply';/);
    expect(LANDING).toMatch(/id="tabSignup"[^>]*>Request access</);
    expect(LANDING).toMatch(/id="signupPassField" style="display:none"/);
    expect(LANDING).toMatch(/id="signupLabel">Request access</);
  });

  it("once open, creates the account straight away, and turns into the application when the email is not on the list", () => {
    const submit = fn("submitAuth");
    expect(submit).toMatch(/postJson\('\/api\/auth\/password\/register', \{ email: email, password: /);
    expect(submit).toMatch(/if \(data\.notWhitelisted\) \{\s+signupStep = 'apply';/);
    expect(submit).toMatch(/postJson\('\/api\/access-request'/);
  });

  it("no longer sends anyone to a wallet email code that does not exist, nor ships an email list", () => {
    expect(LANDING).not.toMatch(/email-code option|isn't live during the whitelist stage/);
    expect(LANDING).not.toMatch(/const WHITELIST/);
  });
});
