import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The admin's Access tab (Kev, 2026-10-07): pending requests with Approve,
 * an invite field for an email and one for a wallet, and the access list.
 * The server sends its data to admins only, and the tab shows only with it.
 */

const PAGE = readSource(join(__dirname, "..", "..", "app", "admin", "page.tsx"));

describe("the admin's Access tab", () => {
  it("shows only when the server sent access data, which it does for admins", () => {
    expect(PAGE).toMatch(/TABS\.filter\(\(t\) => t\.id !== "access" \|\| d\.access\)\.map/);
    expect(PAGE).toMatch(/\{tab === "access" && d\.access && \(/);
  });

  it("approves a request and invites an email or a wallet through the access resource", () => {
    expect(PAGE).toMatch(/body: JSON\.stringify\(\{ resource: "access", \.\.\.payload \}\)/);
    expect(PAGE).toMatch(/grant\(\{ action: "approve", id: r\.id \}, r\.email\)/);
    expect(PAGE).toMatch(/grant\(\{ action: "inviteEmail", email: invEmail \}, invEmail\.trim\(\)\)/);
    expect(PAGE).toMatch(/grant\(\{ action: "inviteWallet", address: invWallet \}, invWallet\.trim\(\)\)/);
  });

  it("grants one at a time, so a double click mails nothing twice", () => {
    expect(PAGE).toMatch(/if \(granting\) \{ say\("Still on the last one, one moment\."\); return false; \}\s*setGranting\(true\);/);
    expect(PAGE).toMatch(/\} finally \{\s*setGranting\(false\);\s*\}/);
  });

  it("says to whom the mail did not go out, and that a re-invite voids the earlier password", () => {
    expect(PAGE).toMatch(/: !r\.mailed \? `\$\{r\.outcome === "reinvited" \? `The earlier password of \$\{who\} no longer works, and the new` : `Account ready for \$\{who\}, but the`\} mail did not go out\. Invite the email again to resend\.`/);
    expect(PAGE).toMatch(/r\.listed === true \? `\$\{who\} is on the access list now\.`/);
    expect(PAGE).toMatch(/: r\.outcome === "reinvited" \? `Invited \$\{who\} again: a fresh one-time password is on its way, the earlier one no longer works\.`/);
  });
});
