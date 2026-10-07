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
    expect(PAGE).toMatch(/grant\(\{ action: "approve", id: r\.id \}\)/);
    expect(PAGE).toMatch(/grant\(\{ action: "inviteEmail", email: invEmail \}\)/);
    expect(PAGE).toMatch(/grant\(\{ action: "inviteWallet", address: invWallet \}\)/);
  });

  it("says when the mail did not go out, so the admin can send it again", () => {
    expect(PAGE).toMatch(/: r\.mailed \? "Invited: the one-time password is on its way\."\s*: "Account ready, but the mail did not go out\. Invite the email again to resend\."/);
  });
});
