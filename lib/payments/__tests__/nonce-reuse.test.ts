import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/** No nonce account is ever orphaned: a second /authorize reuses the first, and the sweep closes unsigned ones. */
const ROOT = join(__dirname, "..", "..", "..");
const AUTHORIZE = readSource(join(ROOT, "app", "api", "payments", "generation", "authorize", "route.ts"));
const SETTLE = readSource(join(ROOT, "lib", "payments", "settle.ts"));

describe("nonce accounts are never orphaned", () => {
  it("a second /authorize reuses the intent's nonce account instead of creating another", () => {
    expect(AUTHORIZE).toMatch(/const reused = intent\.nonce_account \? await readNonce\(solanaConnection\(\), intent\.nonce_account\) : null;/);
    expect(AUTHORIZE).toMatch(/reused && intent\.nonce_account\n\s+\? \{ address: intent\.nonce_account as string, nonce: reused \}\n\s+: await createNonceAccount\(/);
  });

  it("the sweep closes the nonces of unsigned intents as well as stale signed ones", () => {
    expect(SETTLE).toMatch(/\.\.\.\(await sweepAbandoned\(supabase, limit\)\), \.\.\.\(await sweepUnsubmitted\(supabase, limit\)\)/);
  });
});
