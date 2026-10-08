import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * Report button (Kev, 2026-10-08): a simple responsive popup with a reason to
 * pick and a box to say what is wrong, on a prompt, on someone else's public
 * image and on someone else's profile. The route and the admin side have
 * their own tests; this pins where the popup opens and that it never fights
 * the lightbox around it.
 */

const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));
const BUTTON = src("components", "ReportButton.tsx");
const VIEW = src("components", "PromptGeneratorView.tsx");
const PROFILE = src("components", "profile", "ProfileView.tsx");

describe("the popup", () => {
  it("sends the picked reason and the words to the report route with the session", () => {
    expect(BUTTON).toContain('const res = await fetch("/api/reports", {');
    expect(BUTTON).toContain('headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },');
    expect(BUTTON).toContain("body: JSON.stringify({ targetType, targetId, reason, details: details.trim() || undefined }),");
    expect(BUTTON).toContain("{REPORT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}");
  });

  it("asks for words only for 'something else', and shows why a send failed", () => {
    expect(BUTTON).toContain('const needsWords = reason === "other" && !details.trim();');
    expect(BUTTON).toContain("disabled={!reason || needsWords || state.busy}");
    expect(BUTTON).toContain('setState(res.ok ? { sent: true } : { error: d.error ?? "Could not send the report. Try again." });');
  });

  it("sits over the lightbox (level, and later in the page), under the step-up dialog, 16px clear of a phone's edges", () => {
    expect(BUTTON).toContain('className="w-[calc(100%-32px)] max-w-md rounded-lg z-[9999]"');
    expect(BUTTON).toContain('overlayClassName="z-[9999]"');
    expect(src("components", "prompt-generator.css")).toMatch(/\.pgv-lightbox \{\n\s+position: fixed; inset: 0; z-index: 9999;/);
  });

  it("keeps clicks and keys from the lightbox around it: typing never pages it, Escape closes the popup alone", () => {
    expect(BUTTON).toContain('<span className="contents" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>');
    expect(BUTTON).toContain("onEscapeKeyDown={(e) => e.stopPropagation()}");
  });
});

describe("where it opens", () => {
  it("on the prompt page, next to Download", () => {
    expect(VIEW).toMatch(/<Download size=\{13\} \/>\n\s+<\/button>\n\s+<ReportButton targetType="prompt" targetId=\{promptId\} className="pgv-icon-btn">/);
  });

  it("in the lightbox, on a public image that is not the viewer's own", () => {
    expect(VIEW).toContain("const other = own || ownImages.has(url) ? undefined : publicImages.find((p) => p.url === url);");
    expect(VIEW).toContain('<ReportButton targetType="generation" targetId={other.id} className="pgv-lb-public pgv-lb-report pgv-lb-chrome">');
  });

  it("on someone else's profile, never on your own", () => {
    expect(PROFILE).toContain("setCreatorId(d.creator?.id ?? null);");
    expect(PROFILE).toMatch(/\{!own && creatorId && \(\n\s+<ReportButton targetType="user" targetId=\{creatorId\}/);
  });
});
