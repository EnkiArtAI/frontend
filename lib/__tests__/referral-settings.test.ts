import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The Referrals tab in Settings lists the links an account sent in. It read
 * them from the browser, where the old dialog kept them; they are in the
 * moderators' queue now (Kev, 2026-10-05).
 */
const ROOT = join(__dirname, "..", "..");
const DIALOG = readSource(join(ROOT, "components", "enki-shell", "ReferModal.tsx"));
const HOME = readSource(join(ROOT, "components", "enki-shell", "EnkiHome.tsx"));
const SETTINGS = readSource(join(ROOT, "components", "settings", "SettingsView.tsx"));

describe("the browser's own list of referrals", () => {
  it("is gone, with everything that wrote or read it", () => {
    expect(DIALOG).not.toContain("localStorage");
    expect(DIALOG).not.toContain("@/lib/referrals");
    expect(existsSync(join(ROOT, "lib", "referrals.ts"))).toBe(false);
    for (const src of [DIALOG, HOME, SETTINGS]) expect(src).not.toContain("addReferral");
  });
});

describe("the Referrals tab in Settings", () => {
  it("lists what the moderators' queue holds for this account, not what the browser remembered", () => {
    expect(SETTINGS).toContain('fetch("/api/referrals", { headers: sessionAuthHeaders(), credentials: "include" })');
    expect(SETTINGS).not.toContain("listReferrals");
    expect(SETTINGS).toContain('if (activeTab !== "referrals") return;');
  });

  it("says a failed load, and never shows it as no referrals", () => {
    const tab = SETTINGS.slice(SETTINGS.indexOf('{activeTab === "referrals" && ('), SETTINGS.indexOf('{activeTab === "recovery"'));
    expect(tab.indexOf("{referralsFailed ? (")).toBeGreaterThan(-1);
    expect(tab.indexOf("{referralsFailed ? (")).toBeLessThan(tab.indexOf("referrals.length === 0 ? ("));
    expect(tab).toContain("Your referrals could not be loaded.");
    expect(SETTINGS).toContain(".catch(() => { if (live) setReferralsFailed(true); });");
    // An answer that is not ok is a failed load too, a later good one clears it, and before the first answer nothing is claimed.
    expect(SETTINGS).toContain(".then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))");
    expect(SETTINGS).toContain("setReferralsFailed(false);");
    expect(SETTINGS).toContain("useState<Referred[] | null>(null)");
  });

  it("names a platform as people know it, not as the queue files it", () => {
    expect(SETTINGS).toContain("<td>{REFERRAL_PLATFORM_NAME[r.platform as ReferralPlatform] ?? REFERRAL_PLATFORM_NAME.other}</td>");
    expect(SETTINGS).not.toContain("<td>{r.platform}</td>");
  });

  it("states the share as the rule has it: half of the referral share each, on free prompts", () => {
    const tab = SETTINGS.slice(SETTINGS.indexOf('{activeTab === "referrals" && ('), SETTINGS.indexOf('{activeTab === "recovery"'));
    expect(tab).toContain("<strong>{REFERRAL_SHARE_PCT / 2}% of Enki&apos;s {PLATFORM_FEE_PCT}% fee</strong> on every image made with it.");
    expect(tab).toContain("free prompt");
    // Nowhere on the page, its header line included.
    expect(SETTINGS).not.toContain("every sale");
    // No amount earned is shown until earnings are counted somewhere.
    expect(tab).not.toContain("Earned through referrals");
  });
});
