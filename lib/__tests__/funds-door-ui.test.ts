import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Kev, 2026-10-06: a banned account gets Send and the key export on /banned,
 * with a guide for the exported key, and no ramp. One export component serves
 * Settings and /banned, so the password re-check cannot drift between them.
 */

const ROOT = join(__dirname, "..", "..");
const EXPORT = readSource(join(ROOT, "components", "settings", "KeyExport.tsx"));
const BANNED = readSource(join(ROOT, "app", "banned", "page.tsx"));
const BILLING = readSource(join(ROOT, "components", "settings", "BillingPanel.tsx"));

describe("the key export", () => {
  it("re-checks the account password before it asks the wallet for the key", () => {
    const check = EXPORT.search(/await fetch\("\/api\/auth\/password\/login"/);
    const refused = EXPORT.search(/if \(!res\.ok\) throw new Error\("Wrong password"\);/);
    const exported = EXPORT.search(/await requestCdpKeyExport\(\)/);
    expect(check).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(check);
    expect(exported).toBeGreaterThan(refused);
  });

  it("forgets the key when the dialog closes", () => {
    expect(EXPORT).toMatch(/const close = \(\) => \{\s+setStep\(null\); setPw\(""\); setErr\(null\); setKey\(null\);/);
  });

  it("says what to do with the key once it is shown", () => {
    const raw = readFileSync(join(ROOT, "components", "settings", "KeyExport.tsx"), "utf8");
    expect(raw).toMatch(/What to do with it/);
    expect(raw).toMatch(/import an existing wallet with a private key/);
    expect(raw).toMatch(/Enki cannot undo a transfer or restore a lost key/);
  });

  it("is the one export, used by Settings and by /banned", () => {
    expect(BILLING).toMatch(/<KeyExport email=\{email\} ready=\{!!cdpAddress\} \/>/);
    expect(BILLING).not.toMatch(/requestCdpKeyExport/);
    expect(BANNED).toMatch(/<SendUsdcPanel fromAddress=\{embedded\.address\} \/>\s*<KeyExport email=\{email\} ready=\{!!cdpAddress\} \/>/);
  });
});
