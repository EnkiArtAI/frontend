import type { SupabaseClient } from "@supabase/supabase-js";
import { isDbUnreachable, DbUnreachableError } from "@/lib/db-error";

/** Kev, 2026-10-12: one free baseline-model image per UTC day. Premium models remain paid. */
export const FREE_GENERATIONS_PER_DAY = 1;

export interface FreeQuota {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
  resetsAt: string;
}

/** Reads the database's UTC day, from claims rather than deletable image history. */
export async function freeQuotaFor(
  supabase: SupabaseClient,
  userId: string,
): Promise<FreeQuota> {
  const { data, error } = await supabase.rpc("free_generation_quota", { p_user_id: userId });
  if (isDbUnreachable(error)) throw new DbUnreachableError();
  if (error) throw new Error("free quota lookup failed");
  const row = Array.isArray(data) && data.length === 1 ? data[0] : null;
  // Missing migration or a malformed reply must not grant a free generation.
  if (!row || !Number.isSafeInteger(row.used) || row.used < 0
      || row.limit !== FREE_GENERATIONS_PER_DAY
      || row.remaining !== Math.max(0, row.limit - row.used)
      || row.exhausted !== (row.used >= row.limit)
      || typeof row.resets_at !== "string" || !Number.isFinite(Date.parse(row.resets_at))) {
    throw new Error("free quota lookup failed");
  }
  return { used: row.used, limit: row.limit, remaining: row.remaining,
    exhausted: row.exhausted, resetsAt: row.resets_at };
}

export type FreeDecision =
  | { allowed: true; claimId: string }
  | { allowed: false; reason: "sign-in" | "quota"; quota: FreeQuota | null };

/**
 * Claims before the provider is called, under the database's per-account lock.
 * Every account is capped, including team roles. Failed renders release the
 * claim; delivered images keep it even if their history is deleted later.
 */
export async function freeGenerationDecision(
  supabase: SupabaseClient,
  userId: string | null,
): Promise<FreeDecision> {
  if (!userId) return { allowed: false, reason: "sign-in", quota: null };
  const { data: claimId, error } = await supabase.rpc("claim_free_generation", {
    p_user_id: userId,
    p_limit: FREE_GENERATIONS_PER_DAY,
  });
  if (isDbUnreachable(error)) throw new DbUnreachableError();
  if (error) throw new Error("free claim failed");
  if (claimId !== null && (typeof claimId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claimId))) {
    throw new Error("free claim failed");
  }
  return claimId
    ? { allowed: true, claimId }
    : { allowed: false, reason: "quota", quota: await freeQuotaFor(supabase, userId) };
}

/** A failed render gives its claim back; the allowance counts delivered images. */
export async function releaseFreeClaim(supabase: SupabaseClient | null, claimId: string | null): Promise<void> {
  if (!supabase || !claimId) return;
  const { error } = await supabase.from("free_generation_claims").delete().eq("id", claimId);
  if (error) console.warn("[free-quota] claim not given back");
}
