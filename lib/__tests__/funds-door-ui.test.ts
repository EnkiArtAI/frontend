import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Kev, 2026-10-06: a banned account gets Send and the key export on /banned,
 * with a guide for the exported key, and no ramp. One export component serves
 * Settings and /banned, so its second-factor check cannot drift between them;
 * the recovery file asks for the same one.
 */

const ROOT = join(__dirname, "..", "..");
const EXPORT = readSource(join(ROOT, "components", "settings", "KeyExport.tsx"));
const BANNED = readSource(join(ROOT, "app", "banned", "page.tsx"));
const BILLING = readSource(join(ROOT, "components", "settings", "BillingPanel.tsx"));
const RECOVERY = readSource(join(ROOT, "components", "settings", "RecoveryPanel.tsx"));

describe("the key export", () => {
  it("asks for a second factor before it asks the wallet for the key, and no password login", () => {
    for (const src of [EXPORT, RECOVERY]) {
      const check = src.search(/if \(!\(await tokenFor\("export"\)\)\) return;/);
      const exported = src.search(/await requestCdpKeyExport\(\)/);
      expect(check).toBeGreaterThan(-1);
      expect(exported).toBeGreaterThan(check);
    }
    expect(EXPORT).not.toMatch(/\/api\/auth\/password\/login/);
  });

  it("forgets the key when the dialog closes", () => {
    expect(EXPORT).toMatch(/const close = \(\) => \{\s+setOpen\(false\); setErr\(null\); setKey\(null\);/);
  });

  it("says what to do with the key once it is shown", () => {
    const raw = readFileSync(join(ROOT, "components", "settings", "KeyExport.tsx"), "utf8");
    expect(raw).toMatch(/What to do with it/);
    expect(raw).toMatch(/import an existing wallet with a private key/);
    expect(raw).toMatch(/Enki cannot undo a transfer or restore a lost key/);
  });

  it("is the one export, used by Settings and by /banned", () => {
    expect(BILLING).toMatch(/<KeyExport ready=\{!!cdpAddress\} \/>/);
    expect(BILLING).not.toMatch(/requestCdpKeyExport/);
    expect(BANNED).toMatch(/<SendUsdcPanel fromAddress=\{embedded\.address\} \/>\s*<KeyExport ready=\{!!cdpAddress\} \/>/);
  });
});
