import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Kev, 2026-10-06: a banned account gets Send and the key export on /banned,
 * with a guide for the exported key, and no ramp. One export component serves
 * Settings and /banned, so its second-factor check cannot drift between them.
 *
 * CDP-1 (2026-10-09): export moved to Coinbase's secure iframe
 * (useSolanaKeyExportIframe) — the key copies straight to the clipboard and
 * never reaches this component's JS, so there is no longer a key to "forget"
 * and no requestCdpKeyExport call to find. The recovery file's own export
 * (which used to share the same second-factor check) is paused, not ported —
 * see docs/specs/CDP-1.md, Decision 2.
 */

const ROOT = join(__dirname, "..", "..");
const EXPORT = readSource(join(ROOT, "components", "settings", "KeyExport.tsx"));
const BANNED = readSource(join(ROOT, "app", "banned", "page.tsx"));
const BILLING = readSource(join(ROOT, "components", "settings", "BillingPanel.tsx"));
const RECOVERY = readSource(join(ROOT, "components", "settings", "RecoveryPanel.tsx"));

describe("the key export", () => {
  it("asks for a second factor before the dialog (and the export surface) can open, and no password login", () => {
    // confirm() gates setOpen(true) directly inside reveal()...
    expect(EXPORT).toMatch(/if \(!\(await confirm\("export"\)\)\) return;\s*await ensureCdpWallet\(\);\s*setOpen\(true\);/);
    // ...and the container registration (what actually makes CDP's button
    // live) only runs once open is true — it cannot fire before reveal()
    // got past the confirm above.
    expect(EXPORT).toMatch(/if \(!open\) return;\s*setExportIframeContainer\(containerRef\.current\);/);
    expect(EXPORT).not.toMatch(/\/api\/auth\/password\/login/);
  });

  it("the recovery file's own export is paused (CDP-1): nothing there asks for a key any more", () => {
    expect(RECOVERY).not.toMatch(/confirm\("export"\)/);
    expect(RECOVERY).not.toMatch(/requestCdpKeyExport/);
    expect(RECOVERY).not.toMatch(/setExportIframeContainer/);
  });

  it("never holds the key in React state (CDP-1: the iframe copies it directly — there is nothing here to forget)", () => {
    expect(EXPORT).not.toMatch(/setKey\(/);
    expect(EXPORT).toMatch(/const close = \(\) => \{\s*setOpen\(false\); setErr\(null\); setStatus\(null\); setBusy\(false\);\s*\};/);
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
