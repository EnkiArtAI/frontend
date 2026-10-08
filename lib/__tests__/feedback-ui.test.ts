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
const ADMIN = readSource(join(ROOT, "app", "admin", "page.tsx"));

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

describe("the admin panel's Feedback tab", () => {
  it("signs a report's attachments anew each time its row opens, and shows each by its kind", () => {
    expect(ADMIN).toContain("onClick={() => void openFeedback(r)}");
    const open = ADMIN.slice(ADMIN.indexOf("const openFeedback = async (r: Fb) => {"), ADMIN.indexOf("const post = async"));
    expect(open).toContain("if (fbOpen === r.id) { setFbOpen(null); return; }");
    expect(open).toContain("if (!r.images) return;");
    expect(open).toContain("const res = await fetch(`/api/admin?feedback=${encodeURIComponent(r.id)}`, { headers: sessionAuthHeaders() });");
    expect(open).toContain("setFbFiles((cur) => ({ ...cur, [r.id]: files }));");
    expect(ADMIN).toMatch(/\{fbFiles\[r\.id\]\.map\(\(f, i\) => f\.url && \(f\.mime\.startsWith\("video\/"\)\n\s+\? <video key=\{i\} src=\{f\.url\} controls/);
  });

  it("decides a report: Done for an admin alone, Reject while open, Reopen until paid", () => {
    expect(ADMIN).toContain('{ resource: "feedback", action: "setStatus", id: r.id, status: state },');
    expect(ADMIN).toContain("(cur) => ({ ...cur, feedback: cur.feedback.map((x) => (x.id === r.id ? { ...x, state } : x)) }),");
    expect(ADMIN).toMatch(/\{r\.state === "open" && <>\n\s+\{role === "admin" && <Pill kind="green" label="Done"[^\n]*onClick=\{\(\) => decideFb\(r, "done"\)\} \/>\}\n\s+<Pill kind="red" label="Reject" onClick=\{\(\) => decideFb\(r, "rejected"\)\} \/>/);
    expect(ADMIN).toContain('{r.state !== "open" && !r.paid && <Pill kind="plain" label="Reopen" onClick={() => decideFb(r, "open")} />}');
    expect(ADMIN).toContain('<Badge pal={r.paid ? PILL.green : FB_STATE[r.state].pal} label={r.paid ? "Paid" : FB_STATE[r.state].label} />');
  });

  it("counts what waits on staff: open reports to decide and done ones to pay", () => {
    expect(ADMIN).toContain('feedback: data?.feedback.filter((f) => f.state === "open" || (f.state === "done" && !f.paid)).length ?? 0,');
    expect(ADMIN).toContain('{ label: "Feedback to act on", value: counts.feedback,');
    expect(ADMIN).toContain('label={`Done, unpaid ${d.feedback.filter((f) => f.state === "done" && !f.paid).length}`}');
  });

  it("records a payout by its transaction, an admin's alone, once a report is done", () => {
    expect(ADMIN).toContain('{r.state === "done" && !r.paid && role === "admin" && <Pill kind="green" label="Mark paid"');
    expect(ADMIN).toContain('{ resource: "feedback", action: "markPaid", id: r.id, signature: fbSig.trim() }');
    expect(ADMIN).toMatch(/signature: fbSig\.trim\(\) \}[^\n]*\) \{\n\s+setFbPayId\(null\);\n\s+setFbSig\(""\);\n\s+await reload\(\);/);
    // The old one-click Mark paid sent no signature: the route refuses that.
    expect(ADMIN).not.toContain('action: "markPaid", id: r.id }');
  });

  it("names where the $100 goes and links the transfer once sent", () => {
    expect(ADMIN).toContain('{r.wallet ?? "no payable Solana wallet (must re-link)"}');
    expect(ADMIN).toContain('{r.paid && r.txUrl && <a href={r.txUrl} target="_blank" rel="noopener noreferrer"');
  });
});
