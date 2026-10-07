import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The "Refer a prompt" dialog (Kev, 2026-10-05): the link and one button, the
 * link goes to the moderators' queue, and afterwards one short line with a
 * check mark says it arrived. It used to keep the link in the browser and
 * close with a toast, so no moderator ever saw one.
 */
const ROOT = join(__dirname, "..", "..");
const DIALOG = readSource(join(ROOT, "components", "enki-shell", "ReferModal.tsx"));
const HOME = readSource(join(ROOT, "components", "enki-shell", "EnkiHome.tsx"));

describe("the Refer a prompt dialog", () => {
  it("sends the link to the server, signed in as the user", () => {
    const send = DIALOG.slice(DIALOG.indexOf("const send = async () => {"), DIALOG.indexOf("<div className=\"ek-modal-scrim\""));
    expect(send).toContain('await fetch("/api/referrals", {');
    expect(send).toContain('method: "POST",');
    expect(send).toContain('headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },');
    expect(send).toContain("body: JSON.stringify({ url: link.url }),");
  });

  it("reads a link the way the server does, so its button is live only for a link the server takes", () => {
    expect(DIALOG).toContain('import { parseReferralLink, REFERRAL_PLATFORM_NAME } from "@/lib/referral-link";');
    expect(DIALOG).toContain("const link = parseReferralLink(url);");
    expect(DIALOG).toContain("const ready = Boolean(link) && !guest && state === \"idle\";");
    expect(DIALOG).toContain("disabled={!ready}");
  });

  it("says in one short line that the prompt arrived, with a check mark, only once the server took it", () => {
    const send = DIALOG.slice(DIALOG.indexOf("const send = async () => {"), DIALOG.indexOf("<div className=\"ek-modal-scrim\""));
    // The only way into the confirmation is the server's ok.
    expect(DIALOG.split('setState("sent")')).toHaveLength(2);
    expect(DIALOG).toContain('useState<"idle" | "sending" | "sent">("idle")');
    // And nothing after it: falling through would say "could not be sent in" over a stored link.
    expect(send).toContain('if (res.ok) {\n        setState("sent");\n        return;\n      }');
    const sent = DIALOG.slice(DIALOG.indexOf('{state === "sent" ? ('), DIALOG.indexOf(") : ("));
    expect(sent).toContain("Prompt sent in for checks.");
    expect(sent).toContain("We&apos;ll release it shortly.");
    expect(sent).toContain('<Icon name="check"');
    expect(sent).toContain('animation: "ek-pop');
    expect(sent).toContain('role="status"');
  });

  it("shows the server's own sentence when the link is refused, and stays open", () => {
    const send = DIALOG.slice(DIALOG.indexOf("const send = async () => {"), DIALOG.indexOf("<div className=\"ek-modal-scrim\""));
    expect(send).toContain('setError(typeof reason === "string" && reason ? reason : NOT_SENT);');
    expect(send).toContain('setState("idle");');
    expect(DIALOG).toContain('{error && <span role="alert"');
    // The one way to send: the form, so Enter and the button do the same and nothing reloads the page.
    expect(DIALOG).toContain("<form onSubmit={(e) => { e.preventDefault(); void send(); }}>");
    expect(send).not.toContain("onClose()");
  });

  it("is the link and one button: no steps, no promise of a share", () => {
    expect(DIALOG.split("<button").length - 1).toBe(2); // the close cross and the one button
    expect(DIALOG).not.toContain("REFERRAL_SHARE_PCT");
    expect(DIALOG).not.toContain("Earn a passive income");
    expect(DIALOG).not.toContain("Submit for review");
  });
});

describe("where the dialog opens", () => {
  it("is greyed for a visitor who is not signed in, and closes without a toast of its own", () => {
    expect(HOME).toContain("<ReferModal guest={!authed} onClose={() => setReferOpen(false)} />");
    expect(HOME).not.toContain("Referral submitted for review");
  });
});
