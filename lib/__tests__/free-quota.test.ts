import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { freeQuotaFor, freeGenerationDecision, releaseFreeClaim, FREE_GENERATIONS_PER_DAY } from "@/lib/generation/free-quota";

const USER = "11111111-1111-4111-8111-111111111111";
const CLAIM = "22222222-2222-4222-8222-222222222222";
const RESET = "2026-10-13T00:00:00+00:00";
const quotaRow = (used = 0) => ({ used, limit: 1, remaining: Math.max(0, 1 - used), exhausted: used >= 1, resets_at: RESET });
const clientFor = (rpc: ReturnType<typeof vi.fn>) => ({ rpc }) as unknown as SupabaseClient;

describe("freeQuotaFor", () => {
  it("reports one remaining image, using the database UTC reset", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [quotaRow()], error: null });
    expect(await freeQuotaFor(clientFor(rpc), USER)).toEqual({ used: 0, limit: FREE_GENERATIONS_PER_DAY, remaining: 1, exhausted: false, resetsAt: RESET });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("free_generation_quota", { p_user_id: USER });
  });

  it("is exhausted at one image and never reports a negative remainder", async () => {
    for (const used of [1, 9]) {
      const rpc = vi.fn().mockResolvedValue({ data: [quotaRow(used)], error: null });
      expect(await freeQuotaFor(clientFor(rpc), USER)).toMatchObject({ used, remaining: 0, exhausted: true });
    }
  });

  it("fails closed on an error without exposing the raw database message", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "private upstream data" } });
    await expect(freeQuotaFor(clientFor(rpc), USER)).rejects.toThrow("free quota lookup failed");
  });

  it("preserves database outages as outages", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "fetch failed" } });
    await expect(freeQuotaFor(clientFor(rpc), USER)).rejects.toThrow("database unreachable");
  });

  it("refuses missing or malformed quota replies instead of inventing an allowance", async () => {
    for (const data of [null, [], [quotaRow(), quotaRow()], [{ ...quotaRow(), limit: 3 }],
      [{ ...quotaRow(), used: -1 }], [{ ...quotaRow(), remaining: 7 }],
      [{ ...quotaRow(), exhausted: true }], [{ ...quotaRow(), resets_at: "bad date" }]]) {
      const rpc = vi.fn().mockResolvedValue({ data, error: null });
      await expect(freeQuotaFor(clientFor(rpc), USER)).rejects.toThrow("free quota lookup failed");
    }
  });
});

describe("freeGenerationDecision", () => {
  it("refuses an anonymous caller without a database call", async () => {
    const rpc = vi.fn();
    expect(await freeGenerationDecision(clientFor(rpc), null)).toEqual({ allowed: false, reason: "sign-in", quota: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("claims one daily slot without a role exemption", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: CLAIM, error: null });
    expect(await freeGenerationDecision(clientFor(rpc), USER)).toEqual({ allowed: true, claimId: CLAIM });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("claim_free_generation", { p_user_id: USER, p_limit: 1 });
  });

  it("returns the daily quota when no slot is left", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: [quotaRow(1)], error: null });
    expect(await freeGenerationDecision(clientFor(rpc), USER)).toMatchObject({ allowed: false, reason: "quota", quota: { used: 1, remaining: 0, resetsAt: RESET } });
  });

  it("a burst gets one claimed image", async () => {
    let claims = 0;
    const rpc = vi.fn(async (name: string) => ({ data: name === "free_generation_quota" ? [quotaRow(claims)] : claims++ === 0 ? CLAIM : null, error: null }));
    const decisions = await Promise.all(Array.from({ length: 10 }, () => freeGenerationDecision(clientFor(rpc), USER)));
    expect(decisions.filter(d => d.allowed)).toHaveLength(1);
  });

  it("refuses failed or malformed claims", async () => {
    for (const result of [{ data: null, error: { message: "unavailable" } }, { data: undefined, error: null }, { data: "", error: null }, { data: 3, error: null }]) {
      const rpc = vi.fn().mockResolvedValue(result);
      await expect(freeGenerationDecision(clientFor(rpc), USER)).rejects.toThrow("free claim failed");
    }
  });

  it("preserves claim outages as outages", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "ECONNRESET" } });
    await expect(freeGenerationDecision(clientFor(rpc), USER)).rejects.toThrow("database unreachable");
  });
});

describe("releaseFreeClaim", () => {
  it("gives back only the failed claim id", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const del = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ delete: del }));
    await releaseFreeClaim({ from } as unknown as SupabaseClient, CLAIM);
    expect(from).toHaveBeenCalledExactlyOnceWith("free_generation_claims");
    expect(eq).toHaveBeenCalledExactlyOnceWith("id", CLAIM);
  });

  it("does nothing without a claim", async () => {
    const from = vi.fn();
    await releaseFreeClaim({ from } as unknown as SupabaseClient, null);
    expect(from).not.toHaveBeenCalled();
  });
});
