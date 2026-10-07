import { describe, it, expect } from "vitest";
import { freeQuotaFor, FREE_GENERATIONS_PER_ACCOUNT } from "@/lib/generation/free-quota";

/** Minimal stub of the one query shape freeQuotaFor issues. */
function stub(result: { count?: number | null; error?: { message: string } | null }) {
  const calls: Record<string, unknown>[] = [];
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => { calls.push({ eq: [col, val] }); return Promise.resolve(result) as never; },
  };
  return { client: { from: (t: string) => { calls.push({ from: t }); return chain; } }, calls };
}

describe("freeQuotaFor", () => {
  it("reports what is left before the allowance is spent", async () => {
    const { client } = stub({ count: 1, error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = await freeQuotaFor(client as any, "u1");
    expect(q).toEqual({ used: 1, limit: FREE_GENERATIONS_PER_ACCOUNT, remaining: 2, exhausted: false });
  });

  it("is exhausted exactly AT the limit, not one past it", async () => {
    // Off-by-one here is the difference between 3 free images and 4.
    const { client } = stub({ count: FREE_GENERATIONS_PER_ACCOUNT, error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = await freeQuotaFor(client as any, "u1");
    expect(q.exhausted).toBe(true);
    expect(q.remaining).toBe(0);
  });

  it("never reports a negative remainder for an account already over the line", async () => {
    const { client } = stub({ count: 9, error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = await freeQuotaFor(client as any, "u1");
    expect(q.remaining).toBe(0);
    expect(q.exhausted).toBe(true);
  });

  it("counts THIS user's claims, not generations rows or a provider", async () => {
    // generations rows were written after the response (parallel requests all
    // read the same count) and paid renders lacked amount_paid_cents; a
    // provider filter would reset everyone the day the free provider changes.
    const { client, calls } = stub({ count: 0, error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await freeQuotaFor(client as any, "user-42");
    expect(calls).toEqual([{ from: "free_generation_claims" }, { eq: ["user_id", "user-42"] }]);
  });

  it("throws on a failed lookup instead of granting a free generation", async () => {
    // Treating an outage as "0 used" turns a database blip into an unlimited
    // free tier — the expensive direction to be wrong in.
    const { client } = stub({ count: null, error: { message: "connection reset" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(freeQuotaFor(client as any, "u1")).rejects.toThrow(/free quota lookup failed/);
  });
});

import { freeGenerationDecision } from "@/lib/generation/free-quota";

/** Stub of what the decision issues: users.role, the claim, and the count when refused. */
function decisionStub(opts: { role?: string | null; roleError?: boolean; count?: number; claimError?: boolean }) {
  const seen: string[] = [];
  const usersChain = {
    select: () => usersChain,
    eq: () => usersChain,
    is: () => usersChain,
    maybeSingle: () =>
      Promise.resolve(
        opts.roleError
          // Error AND a role that WOULD grant the exemption. With data:null the
          // case proves nothing — the `data &&` guard alone would pass it, so
          // the `!error` half of the check would be untested.
          ? { data: { role: "admin" }, error: { message: "boom" } }
          : { data: opts.role === undefined ? null : { role: opts.role }, error: null },
      ),
  };
  let claims = opts.count ?? 0;
  const claimChain = {
    select: () => claimChain,
    eq: () => Promise.resolve({ count: claims, error: null }) as never,
  };
  return {
    from: (t: string) => { seen.push(t); return t === "users" ? usersChain : claimChain; },
    // The database's claim_free_generation: one claim while under the limit, else null.
    rpc: (fn: string, args: { p_limit: number }) => {
      seen.push(fn);
      if (opts.claimError) return Promise.resolve({ data: null, error: { message: "boom" } });
      return Promise.resolve({ data: claims < args.p_limit ? `claim-${++claims}` : null, error: null });
    },
    seen,
  };
}

describe("freeGenerationDecision", () => {
  it("refuses an anonymous caller — there is no account to count against", async () => {
    // This is the hole: without it, the way around three-per-account was to log out.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await freeGenerationDecision(decisionStub({}) as any, null);
    expect(d).toEqual({ allowed: false, reason: "sign-in", quota: null });
  });

  it("lets the team through without a limit", async () => {
    for (const role of ["admin", "mod"]) {
      const stub = decisionStub({ role, count: 999 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = await freeGenerationDecision(stub as any, "kev");
      expect(d).toEqual({ allowed: true, claimId: null });
      // and it never even claims — the exemption is not a large allowance
      expect(stub.seen).not.toContain("claim_free_generation");
    }
  });

  it("holds an ordinary account to the allowance", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const under = await freeGenerationDecision(decisionStub({ role: "beta", count: 1 }) as any, "u");
    expect(under).toEqual({ allowed: true, claimId: "claim-2" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const over = await freeGenerationDecision(decisionStub({ role: "beta", count: 3 }) as any, "u");
    expect(over).toMatchObject({ allowed: false, reason: "quota", quota: { used: 3, remaining: 0 } });
  });

  it("takes the allowance by claiming it, so a burst gets only what is left", async () => {
    const stub = decisionStub({ role: "user", count: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const burst = await Promise.all(Array.from({ length: 10 }, () => freeGenerationDecision(stub as any, "u")));
    expect(burst.filter((d) => d.allowed)).toHaveLength(2);
  });

  it("refuses when the claim itself fails, instead of granting a free render", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(freeGenerationDecision(decisionStub({ role: "user", claimError: true }) as any, "u")).rejects.toThrow(/free claim failed/);
  });

  it("does not grant the team exemption when the role lookup fails", async () => {
    // An outage must not hand anyone unlimited free generation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await freeGenerationDecision(decisionStub({ roleError: true, count: 3 }) as any, "u");
    expect(d.allowed).toBe(false);
    expect(d).toMatchObject({ reason: "quota" });
  });

  it("treats an unknown role as an ordinary account, not as team", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await freeGenerationDecision(decisionStub({ role: "administrator", count: 3 }) as any, "u");
    expect(d.allowed).toBe(false);
  });
});
