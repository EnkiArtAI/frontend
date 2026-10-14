/**
 * DB-driven discount rules for generation payments.
 *
 * Rules live in pricing_rules (edit in the DB → active within ~60s, no deploy).
 * computeQuote applies the best matching rule, so quote AND intent (and thus
 * pay, which charges what the intent persisted) always agree.
 *
 * Effects never touch the artist share:
 *   fee_percent_off  → reduces only the Enki fee
 *   free_generation  → waives the buyer's Enki leg (model cost + fee),
 *                      optionally capped per user per UTC day (quota is
 *                      derived from intents: reserved on creation, refunded
 *                      by expiry, permanent once fulfilled)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GenerationSplit } from "@/lib/payments/generation-pricing";

export type RuleEffect =
  | { type: "fee_percent_off"; value: number }
  | { type: "free_generation"; uses_per_day?: number };

interface RuleRow {
  id: string;
  name: string;
  priority: number;
  audience: { roles?: string[]; ranks?: string[]; user_ids?: string[] } | null;
  scope: { models?: string[]; prompt_ids?: string[] } | null;
  effect: RuleEffect;
}

export interface AppliedRule {
  id: string;
  name: string;
  effect: RuleEffect;
}

const CACHE_TTL_MS = 60_000;
let cache: { rules: RuleRow[]; at: number } | null = null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadActiveRules(supabase: SupabaseClient): Promise<RuleRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rules;
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("pricing_rules")
    .select("id, name, priority, audience, scope, effect")
    .eq("active", true)
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
    .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
    .order("priority", { ascending: false });
  if (error) {
    // Table missing (migration not run) or transient error → no discounts,
    // never a broken quote.
    if (!error.message?.includes("schema cache")) {
      console.error("[pricing-rules] load failed:", error.message);
    }
    return cache?.rules ?? [];
  }
  cache = { rules: (data ?? []) as RuleRow[], at: Date.now() };
  return cache.rules;
}

/** requireAuth's userId is a wallet address (or the users.id bridge) — map it to users.id. */
async function resolveBuyerId(supabase: SupabaseClient, walletOrId: string): Promise<string | null> {
  if (UUID.test(walletOrId)) return walletOrId;
  const { data } = await supabase
    .from("user_wallets")
    .select("user_id")
    .ilike("address", walletOrId) // sessions store lowercased addresses
    .is("removed_at", null)
    .maybeSingle();
  return data?.user_id ?? null;
}

/**
 * Highest-priority active rule matching this buyer + model + prompt, or null.
 * Every field given in audience/scope must match (AND); {} matches everything.
 */
export async function resolvePricingRule(
  supabase: SupabaseClient,
  args: { buyerWalletOrId: string; modelFamily: string; promptId?: string; excludeFreeGeneration?: boolean },
): Promise<AppliedRule | null> {
  const rules = await loadActiveRules(supabase);
  if (rules.length === 0) return null;

  const buyerId = await resolveBuyerId(supabase, args.buyerWalletOrId);
  if (!buyerId) return null; // discounts require an identified account

  // Role/rank degrade independently: the ranks migration (users.rank_key) is
  // deliberately not run yet, so a failed combined select must not also lose
  // the role (mods/admins would silently miss role-targeted rules).
  let role = "user";
  let rank: string | null = null;
  const me = await supabase.from("users").select("role, rank_key").eq("id", buyerId).maybeSingle();
  if (!me.error && me.data) {
    role = (me.data as { role?: string }).role ?? "user";
    rank = (me.data as { rank_key?: string | null }).rank_key ?? null;
  } else {
    const fb = await supabase.from("users").select("role").eq("id", buyerId).maybeSingle();
    if (!fb.error && fb.data) role = (fb.data as { role?: string }).role ?? "user";
  }

  for (const r of rules) {
    // Daily free baseline is handled by its atomic quota; paid catalogue models stay paid.
    if (args.excludeFreeGeneration && r.effect?.type === "free_generation") continue;
    const a = r.audience ?? {};
    if (a.roles && !a.roles.includes(role)) continue;
    if (a.ranks && (!rank || !a.ranks.includes(rank))) continue;
    if (a.user_ids && !a.user_ids.includes(buyerId)) continue;
    const s = r.scope ?? {};
    if (s.models && !s.models.includes(args.modelFamily)) continue;
    if (s.prompt_ids && (!args.promptId || !s.prompt_ids.includes(args.promptId))) continue;

    if (r.effect?.type === "free_generation" && r.effect.uses_per_day) {
      // FAILPROOF QUOTA (Kev, 2026-07-12): a use is RESERVED the moment a
      // discounted intent is created (this check runs before the insert, so
      // parallel intents can't stack past the cap) and refunds itself
      // automatically — an intent only keeps counting while it is fulfilled
      // OR still alive (unexpired). Cancelled/failed generations expire in
      // minutes and free the slot; no counter table, no drift, nothing to
      // game: the count is over committed intent rows.
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const nowIso = new Date().toISOString();
      const { count, error } = await supabase
        .from("generation_payment_intents")
        .select("id", { count: "exact", head: true })
        .eq("applied_rule_id", r.id)
        .eq("buyer_wallet", args.buyerWalletOrId)
        .gte("created_at", dayStart.toISOString())
        .or(`fulfilled_at.not.is.null,expires_at.gte.${nowIso}`);
      if (error) continue;                                   // fail CLOSED: no free ride on errors
      if ((count ?? 0) >= r.effect.uses_per_day) continue;   // today's quota reserved/used
    }
    if (r.effect?.type !== "fee_percent_off" && r.effect?.type !== "free_generation") continue;
    return { id: r.id, name: r.name, effect: r.effect };
  }
  return null;
}

/** Apply an effect to a split. The artist share is NEVER reduced. */
export function applyRuleToSplit(split: GenerationSplit, rule: AppliedRule): GenerationSplit {
  if (rule.effect.type === "fee_percent_off") {
    const pct = Math.min(100, Math.max(0, rule.effect.value));
    // The discount touches only the PLATFORM part of the fee. The network fee
    // is a passed-through cost, not margin — "100% off the fee" waiving it
    // would have Enki paying the chain out of pocket on every discounted
    // sale, which is a silent per-sale loss no campaign ever priced in.
    const platformFeeMicro = split.enkiFeeMicro - split.networkFeeMicro;
    const enkiFeeMicro =
      split.networkFeeMicro + platformFeeMicro - Math.floor((platformFeeMicro * pct) / 100);
    const enkiTotalMicro = split.modelCostMicro + enkiFeeMicro;
    return { ...split, enkiFeeMicro, enkiTotalMicro, totalMicro: split.artistAmountMicro + enkiTotalMicro };
  }
  // free_generation — Enki subsidizes its whole leg, the network fee
  // included: a "free" generation that still bills half a cent is not free,
  // it is a support ticket. NOTE for the pay route: on a free prompt this
  // makes totalMicro 0; a zero-total intent must be short-circuited (no
  // on-chain transfer, mark paid directly).
  return {
    ...split,
    modelCostMicro: 0,
    enkiFeeMicro: 0,
    networkFeeMicro: 0,
    enkiTotalMicro: 0,
    totalMicro: split.artistAmountMicro,
  };
}

// NOTE: there is deliberately NO redemption counter. Free-use quotas are
// derived from generation_payment_intents rows (see resolvePricingRule) —
// reserved at intent creation, auto-refunded by expiry, permanent once
// fulfilled. Counters would drift; committed rows can't.
