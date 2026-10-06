import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";
import { isSessionStorageKey } from "@/lib/session-headers";

/**
 * BetaGate re-checked on EVERY storage event from another tab and blanked the
 * page while it did. The editors autosave every 400 ms, so typing in one tab
 * unmounted the whole app in every other tab, an open Editor 2 graph with it
 * (Kev, 2026-10-06).
 */

const ROOT = join(__dirname, "..", "..");
const GATE = readSource(join(ROOT, "components", "BetaGate.tsx"));

describe("which storage changes re-check the session", () => {
  it("a session key, or the whole store cleared", () => {
    for (const key of ["enki_session_token", "turnkey_session_token", "solana-auth-session", null]) {
      expect(isSessionStorageKey(key)).toBe(true);
    }
  });

  it("never an editor draft, the 18+ pill or the theme", () => {
    for (const key of ["symphora-editor-draft-v1", "enki-node-creator-draft", "enki:show-adult", "theme"]) {
      expect(isSessionStorageKey(key)).toBe(false);
    }
  });

  it("every key sessionAuthHeaders reads a session from", () => {
    const src = readFileSync(join(ROOT, "lib", "session-headers.ts"), "utf8");
    const body = src.slice(src.indexOf("export function sessionAuthHeaders"), src.indexOf("/** The localStorage keys"));
    const keys = [...body.matchAll(/localStorage\.getItem\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(isSessionStorageKey(key)).toBe(true);
  });
});

describe("BetaGate", () => {
  it("re-checks on a storage event only for a session key", () => {
    expect(GATE).toMatch(/const onStorage = \(e: StorageEvent\) => \{ if \(isSessionStorageKey\(e\.key\)\) rerun\(\); \};/);
    expect(GATE).toMatch(/window\.addEventListener\("storage", onStorage\);/);
    expect(GATE).not.toMatch(/addEventListener\("storage", rerun\)/);
  });

  it("keeps the page mounted while it re-checks", () => {
    expect(GATE).toMatch(/const rerun = \(\) => setTick\(\(t\) => t \+ 1\);/);
    expect(GATE).not.toMatch(/setAccess\("checking"\)/);
  });
});
