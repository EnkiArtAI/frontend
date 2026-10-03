/**
 * Visible warnings and the suspensions they lead to (Kev, 2026-10-03).
 *
 * A request for explicit sexual content is refused with a warning the user
 * sees. Every tenth warning suspends the account for the next step of the
 * ladder: 3 days, 7 days, 1 month, 2 months, 6 months, 1 year, for good. A
 * request for sexual content involving minors weighs ten warnings, so the
 * first one already suspends, and it goes to the review queue. Warnings live
 * in automod_events; an admin who overturns one takes it out of the count.
 * Requests without an account (the free generator, agents) count by hashed
 * IP and stop that address at the first step.
 */
import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sealEvidence } from "@/lib/moderation/evidence";
import { getClientIp, hashIp } from "@/lib/ip-hash";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { banUntil } from "@/lib/moderation/bans";
import { notifyAdmins } from "@/lib/admin-notify";

export const WARNINGS_PER_STEP = 10;
/** Days per step; null is for good. */
export const SUSPENSION_LADDER_DAYS: readonly (number | null)[] = [3, 7, 30, 60, 180, 365, null];
export const WARNING_WEIGHT = { explicit_sexual: 1, minor_sexual: 10 } as const;
export type WarningCategory = keyof typeof WARNING_WEIGHT;
const CATEGORIES = Object.keys(WARNING_WEIGHT);
export const ADDRESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type Req = { headers: { get(name: string): string | null } };

export interface WarningOutcome {
  /** Weighted warnings counted so far, this one included. */
  total: number;
  /** The suspension this warning started: an ISO date, "forever", or null. */
  suspendedUntil: string | "forever" | null;
  /** The total at which the next suspension starts. */
  nextStepAt: number;
}

/**
 * The warning count, for enforcement and for the admin panel alike: the weights
 * of the warning categories, without overturned ones. One rule, so what an admin
 * sees is what suspends.
 */
export function warningWeight(rows: { category?: unknown; review_state?: unknown; scores?: { weight?: unknown } | null }[]): number {
  return rows
    .filter((r) => CATEGORIES.includes(String(r.category)) && r.review_state !== "overturned")
    .reduce((s, r) => s + (Number(r.scores?.weight) || 0), 0);
}

export async function weightSince(supabase: SupabaseClient, who: { userId: string | null; ipHash: string | null }, since?: string): Promise<number> {
  let q = supabase.from("automod_events").select("category, review_state, scores").in("category", CATEGORIES).neq("review_state", "overturned");
  if (since) q = q.gte("created_at", since);
  if (who.userId) q = q.eq("user_id", who.userId);
  else if (who.ipHash) q = q.is("user_id", null).eq("ip_hash", who.ipHash);
  else return 0;
  const { data } = await q;
  return warningWeight((data ?? []) as Parameters<typeof warningWeight>[0]);
}

/** An address without an account that has reached the first step in the last 30 days. */
export async function addressWarnedOut(supabase: SupabaseClient, request: Req): Promise<boolean> {
  const ipHash = hashIp(getClientIp(request));
  if (!ipHash) return false;
  const since = new Date(Date.now() - ADDRESS_WINDOW_MS).toISOString();
  return (await weightSince(supabase, { userId: null, ipHash }, since)) >= WARNINGS_PER_STEP;
}

export async function recordWarning(
  supabase: SupabaseClient,
  ctx: {
    surface: string; request: Req; category: WarningCategory; confidence: number;
    /** What a moderator may read; withheld and promptId as in lib/moderation/evidence. */
    text: string; withheld?: string; promptId?: string;
  },
): Promise<WarningOutcome> {
  const weight = WARNING_WEIGHT[ctx.category];
  const token = ctx.request.headers.get("X-Session-Token");
  // The account even while it is suspended: a request made during a
  // suspension still belongs to it, child-safety ones above all.
  const userId = token ? await resolveSessionUserWithBan(supabase, token).then((s) => s.userId).catch(() => null) : null;
  const ipHash = hashIp(getClientIp(ctx.request));
  // A crypto config problem stores the warning without it rather than lose it.
  const evidence = sealEvidence({ shown: ctx.text, withheld: ctx.withheld, promptId: ctx.promptId });

  await supabase.from("automod_events").insert({
    user_id: userId,
    ip_hash: ipHash,
    surface: ctx.surface,
    decision: "block",
    severity: "strike",
    tier: 2,
    category: ctx.category,
    scores: { confidence: ctx.confidence, weight },
    prompt_hash: createHash("sha256").update(ctx.text + (ctx.withheld ?? "")).digest("hex"),
    evidence_ct: evidence?.encrypted ?? null,
    evidence_iv: evidence?.iv ?? null,
    evidence_tag: evidence?.authTag ?? null,
    evidence_kid: evidence?.kid ?? null,
    // A child-safety request always gets a human's eyes; the rest is listed per person.
    review_state: ctx.category === "minor_sexual" ? "pending" : "none",
  });

  const total = await weightSince(supabase, { userId, ipHash });
  const stepNow = Math.floor(total / WARNINGS_PER_STEP);
  const stepBefore = Math.floor((total - weight) / WARNINGS_PER_STEP);
  const outcome: WarningOutcome = { total, suspendedUntil: null, nextStepAt: (stepNow + 1) * WARNINGS_PER_STEP };

  if (userId && stepNow > stepBefore) {
    const days = SUSPENSION_LADDER_DAYS[Math.min(stepNow, SUSPENSION_LADDER_DAYS.length) - 1];
    const expiresAt = days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    // A stable reason per step: past the last step every one is the same
    // sanction, so a banned account cannot pile up rows (lib/moderation/bans.ts).
    const suspended = await suspend(supabase, userId, expiresAt, `Automated: warnings, step ${Math.min(stepNow, SUSPENSION_LADDER_DAYS.length)}`);
    // A running longer ban stays as it is; the outcome reports the real end.
    if (suspended) outcome.suspendedUntil = suspended.until ?? "forever";
  }

  if (ctx.category === "minor_sexual" || outcome.suspendedUntil) {
    await notifyAdmins(supabase, {
      subject: `${ctx.category === "minor_sexual" ? "Child-safety request" : "Suspension"}: ${userId ? `account ${userId}` : "no account (hashed IP)"}`,
      text:
        `${ctx.surface}: ${ctx.category} (confidence ${ctx.confidence.toFixed(2)}), ${total} weighted warnings. ` +
        (outcome.suspendedUntil ? `Suspended until ${outcome.suspendedUntil}. ` : "") +
        "The request is in the admin moderation list.",
    }).catch(() => {});
  }
  return outcome;
}

async function suspend(supabase: SupabaseClient, userId: string, expiresAt: string | null, reason: string): Promise<{ until: string | null } | null> {
  // bans.issued_by is NOT NULL: issued in the name of the moderation owner,
  // who answers for it and can lift it, like the existing auto-ban.
  const { data: policy } = await supabase.from("moderation_policy").select("owner_user_id").eq("id", 1).maybeSingle();
  const issuedBy = policy?.owner_user_id as string | undefined;
  if (!issuedBy) return null;
  // A warning is always answered; an unreachable database only costs the suspension.
  return banUntil(supabase, { userId, issuedBy, reason, expiresAt }).catch(() => null);
}

function duration(days: number | null): string {
  if (days === null) return "for good";
  if (days % 365 === 0) return days === 365 ? "1 year" : `${days / 365} years`;
  if (days % 30 === 0) return days === 30 ? "1 month" : `${days / 30} months`;
  return `${days} days`;
}

/** What the user reads. It names the rule and the count, never the score. */
export function warningMessage(category: WarningCategory, o: WarningOutcome, refused: "generation" | "save" = "generation"): string {
  const rule =
    category === "minor_sexual"
      ? "Sexual content involving minors is strictly prohibited."
      : "Explicit sexual content isn't allowed on Enki.";
  const head = `${rule} ${refused === "save" ? "Nothing was saved." : "Nothing was generated and nothing was charged."}`;
  if (o.suspendedUntil === "forever") return `${head} Your account is suspended for good.`;
  if (o.suspendedUntil) return `${head} Your account is suspended until ${o.suspendedUntil.slice(0, 10)}.`;
  const step = Math.floor(o.nextStepAt / WARNINGS_PER_STEP);
  const next = duration(SUSPENSION_LADDER_DAYS[Math.min(step, SUSPENSION_LADDER_DAYS.length) - 1]);
  return `${head} This is warning ${o.total} of ${o.nextStepAt}; at ${o.nextStepAt} your account is suspended ${next === "for good" ? "for good" : `for ${next}`}.`;
}
