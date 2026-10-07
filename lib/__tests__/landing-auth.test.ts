import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * The landing's login is real (Kev, 2026-10-07): email + password log in and
 * open the app at once. Sign-up is wired but closed in the private beta: the
 * access form takes applications; opened, it creates the account and falls
 * back to the application for an email not on the access list. The
 * page is static HTML: the login is read from its script (and was run in a
 * browser against the dev server); the sign-up script runs for real against
 * a small fake DOM, closed as it ships and opened as it will be.
 */

const LANDING = readFileSync(join(__dirname, "..", "..", "public", "landing.html"), "utf8");
const fn = (name: string) => {
  const start = LANDING.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return LANDING.slice(start, LANDING.indexOf("\n}\n", start));
};

// The page's sign-up script (postJson … showInlineNote), run against a fake
// DOM with SIGNUP_OPEN as given; fetch answers per URL.
type El = {
  style: { display: string }; textContent: string; value: string; required: boolean; disabled: boolean;
  classList: { add(): void; remove(): void }; listeners: Record<string, () => void>; note: El | null; parent?: El;
  className?: string; addEventListener(t: string, f: () => void): void; querySelector(): El | null;
  insertBefore(n: El): void; remove(): void;
};
function runSignup(open: boolean) {
  const els = new Map<string, El>();
  const make = (): El => {
    const e: El = {
      style: { display: "" }, textContent: "", value: "", required: false, disabled: false,
      classList: { add() {}, remove() {} }, listeners: {}, note: null,
      addEventListener: (t, f) => { e.listeners[t] = f; },
      querySelector: () => e.note,
      insertBefore: (n) => { e.note = n; n.parent = e; },
      remove: () => { if (e.parent) e.parent.note = null; },
    };
    return e;
  };
  const el = (id: string) => { if (!els.has(id)) els.set(id, make()); return els.get(id)!; };
  const answers = new Map<string, { ok: boolean; body: unknown }>();
  const posts: { url: string; body: unknown }[] = [];
  const adopted: unknown[] = [];
  const fetch = vi.fn(async (url: string, init: { body: string }) => {
    posts.push({ url, body: JSON.parse(init.body) });
    const a = answers.get(url) ?? { ok: true, body: {} };
    return { ok: a.ok, json: async () => a.body };
  });
  const start = LANDING.indexOf("function postJson(");
  const end = LANDING.indexOf("\n}\n", LANDING.indexOf("function showInlineNote(")) + 3;
  const script = LANDING.slice(start, end).replace("const SIGNUP_OPEN = false;", `const SIGNUP_OPEN = ${open};`);
  expect(script).toContain(`const SIGNUP_OPEN = ${open};`);
  const page = new Function(
    "document", "fetch", "adoptSession", "switchAuthTab", "showAuthSuccess",
    `${script}\nreturn { submitAuth, step: () => signupStep };`,
  )({ getElementById: el, createElement: make }, fetch, (d: unknown) => adopted.push(d), () => {}, () => {});
  return {
    el, posts, adopted,
    step: page.step as () => string,
    submit: () => page.submitAuth({ preventDefault() {} }, "signup"),
    answer: (url: string, ok: boolean, body: unknown) => answers.set(url, { ok, body }),
  };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

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

  it("takes an application while closed, and never creates an account", async () => {
    const page = runSignup(false);
    page.el("signupEmail").value = "new@example.com";
    page.el("appAbout").value = "I paint with prompts";
    page.submit();
    await settle();
    expect(page.posts.map((p) => p.url)).toEqual(["/api/access-request"]);
    expect(page.el("signupEmail").listeners.input).toBeUndefined();
  });

  it("once open, turns into the application for an email not on the list, and starts over when the email is corrected", async () => {
    const page = runSignup(true);
    expect([page.step(), page.el("signupPass").required, page.el("signupLabel").textContent]).toEqual(["account", true, "Create account"]);
    page.answer("/api/auth/password/register", false, { error: "not on the list", notWhitelisted: true });
    page.el("signupEmail").value = "kev@gmial.com";
    page.el("signupPass").value = "a long password";
    page.submit();
    await settle();
    expect([page.step(), page.el("signupPassField").style.display, page.el("signupPass").required, page.el("applyFields").style.display]).toEqual(["apply", "none", false, ""]);
    expect(page.el("formSignup").note?.textContent).toMatch(/isn't on the access list/);

    page.el("signupEmail").value = "kev@gmail.com";
    page.el("signupEmail").listeners.input();
    expect([page.step(), page.el("signupPass").required, page.el("signupLabel").textContent]).toEqual(["account", true, "Create account"]);
    expect(page.el("formSignup").note).toBeNull();
    page.answer("/api/auth/password/register", true, { token: "t", email: "kev@gmail.com" });
    page.submit();
    await settle();
    expect(page.posts.map((p) => p.url)).toEqual(["/api/auth/password/register", "/api/auth/password/register"]);
    expect(page.adopted).toEqual([{ token: "t", email: "kev@gmail.com" }]);
  });

  it("no longer sends anyone to a wallet email code that does not exist, nor ships an email list", () => {
    expect(LANDING).not.toMatch(/email-code option|isn't live during the whitelist stage/);
    expect(LANDING).not.toMatch(/const WHITELIST/);
  });
});
