import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The "$100 for feedback" program's screens (Kev, 2026-10-08). They are React
 * components that cannot run in node, so their wiring is pinned; what the
 * routes answer is tested in feedback-program.
 */
const ROOT = join(__dirname, "..", "..");
const MODAL = readSource(join(ROOT, "components", "enki-shell", "FeedbackModal.tsx"));

describe("the feedback modal", () => {
  it("lists the sender's own reports with the session, a guest none", () => {
    expect(MODAL).toMatch(/useEffect\(\(\) => \{\n\s+if \(guest\) return;[\s\S]{0,120}const res = await fetch\("\/api\/feedback", \{ headers: sessionAuthHeaders\(\) \}\);/);
    expect(MODAL).toContain("if (d && !dead) setMine(d.items);");
  });

  it("says what became of each, and links a payment to its transfer", () => {
    expect(MODAL).toContain('const STATE_LABEL: Record<FeedbackDecision, string> = { open: "In review", done: "Done", rejected: "Declined" };');
    expect(MODAL).toMatch(/\{m\.paid && m\.txUrl\n\s+\? <a href=\{m\.txUrl\} target="_blank" rel="noopener noreferrer"/);
    expect(MODAL).toContain(': <span style={{ fontSize: 10, color: "var(--enki-ink-3)", flexShrink: 0 }}>{m.paid ? "Paid" : STATE_LABEL[m.state]}</span>}');
  });
});
