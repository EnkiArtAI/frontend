/**
 * Recording side of moderation — separate from lib/moderation on purpose.
 *
 * lib/moderation decides and touches no database; this writes the decision down
 * and decides what (if anything) happens to the account. Keeping them apart is
 * what lets the decision engine be unit-tested without mocking Supabase.
 *
 * Every decision is written, allow and block alike — automod_events is the
 * evaluation dataset, not just an incident log. Only blocks carry the prompt
 * (encrypted); passes carry scores and a hash.
 *
 * Enforcement policy (Kev, 2026-08-04):
 *   Blocking is cheap — it costs a user one attempt.
 *   Banning is expensive — it costs them their account and us a customer.
 * So nothing here bans. A regex never can, and even the AI tier's strongest
 * signal only raises a case to 'pending' review. Bans are issued by a human or
 * the council, through the existing `bans` table — which is also why
 * bans.issued_by is NOT NULL: the schema already assumes a human signs off.
 */
import { getSupabaseServerClientSafe } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { banUntil } from "@/lib/moderation/bans";
import { getClientIp, hashIp } from "@/lib/ip-hash";
import { encryptString } from "@/lib/crypto";
import type { ModerationVerdict } from "@/lib/moderation";

export interface RecordContext {
  surface: string;
  /**
   * The request — the session token and client IP are read off it here, and
   * nothing else is. Typed by that rather than as NextRequest so handlers
   * taking a plain `Request` can still record their verdicts; a route that
   * cannot report is a route that silently stops being evidence.
   */
  request: { headers: { get(name: string): string | null } };
  /** The prompt itself; stored encrypted, never in clear. */
  prompt: string;
}

/**
 * Fire-and-forget: a failure to record must never break a generation, and must
 * never be the reason a block does not happen (the block already happened at
 * the call site).
 */
export async function recordModerationEvent(
  verdict: ModerationVerdict,
  ctx: RecordContext,
): Promise<void> {
  // EVERY decision is recorded, clean passes included (Kev, 2026-08-05).
  //
  // Blocks alone cannot be evaluated: a threshold is only meaningful against
  // the distribution of the scores that fell *below* it. Without the passes we
  // could see that MINORS_REVIEW = 0.3 fired 12 times, but never that it sat
  // just above a cluster of 0.28s — so we could never tell whether it is too
  // tight or too loose. The passes are the control group.
  //
  // What a pass does NOT carry is the prompt text (see the evidence block
  // below): scores and a hash make it analysable, ciphertext for every
  // generation would make this table an archive of everything anyone ever
  // wrote — a liability with no analytical payoff.

  try {
    const supabase = getSupabaseServerClientSafe();
    if (!supabase) return;

    // Identity is derived server-side from the session, never from a
    // client-supplied wallet field: PR #54 keyed enforcement on a body
    // parameter, so anyone could get someone else's wallet struck, or omit it
    // and be untraceable. /api/generate-free has no session at all — those
    // events are attributed by hashed IP only, which is why user_id is nullable.
    const token = ctx.request.headers.get("X-Session-Token");
    let userId: string | null = null;
    if (token) {
      // The account even while it is suspended: a request made during a
      // suspension still belongs to it.
      userId = await resolveSessionUserWithBan(supabase, token).then((s) => s.userId).catch(() => null);
    }

    // Evidence is encrypted at rest: a blocked CSAM prompt is itself a liability
    // in plaintext. The hash (in lib/moderation) carries repeat-offender
    // detection without holding the text readable.
    let evidence: { encrypted: string; iv: string; authTag: string; kid?: string } | null = null;
    if (!verdict.allowed) {
      try {
        evidence = encryptString(ctx.prompt.slice(0, 4000));
      } catch {
        evidence = null; // never let a crypto config problem lose the event
      }
    }

    await supabase.from("automod_events").insert({
      user_id: userId,
      ip_hash: hashIp(getClientIp(ctx.request)),
      surface: ctx.surface,
      decision: verdict.allowed ? "allow" : "block",
      severity: verdict.enforcement === "none" ? "log" : verdict.enforcement,
      tier: verdict.tier,
      // A degraded pass and a clean tier-1-only pass are otherwise identical
      // rows (tier null, scores null), which would silently inflate the "AI
      // saw it and was fine with it" bucket with prompts the AI never saw.
      // Marked in `category` rather than a new column: a degraded verdict
      // carries no category of its own, so nothing is lost.
      category: verdict.tier2Degraded ? "tier2_degraded" : verdict.category,
      matched_rules: verdict.matchedRules.length ? verdict.matchedRules : null,
      scores: verdict.scores,
      prompt_hash: verdict.promptHash,
      evidence_ct: evidence?.encrypted ?? null,
      evidence_iv: evidence?.iv ?? null,
      evidence_tag: evidence?.authTag ?? null,
      evidence_kid: evidence?.kid ?? null,
      // Only the ambiguous band reaches a human. Everything else is recorded
      // and forgotten unless a pattern shows up in the numbers.
      review_state: verdict.enforcement === "review" ? "pending" : "none",
    });

    if (userId) await maybeAutoBan(supabase, userId, verdict);
  } catch {
    /* recording is best-effort by design */
  }
}

/**
 * The one case severe enough to act on without waiting for a human.
 *
 * The trigger is deliberately narrow — ONLY the AI classifier's
 * `sexual/minors` score at >= 0.9, never the word list. That split is the whole
 * lesson of the earlier audit: the word list matched "nude girl statue,
 * classical marble" and would have permanently banned a paying artist, because
 * it reads letters. The classifier reads meaning, and at 0.9 on that specific
 * category there is no benign reading left.
 *
 * Anything below stays with a human. An automated ban is appealable through the
 * normal /banned flow like any other.
 */
const AUTO_BAN_MINORS_SCORE = 0.9;

async function maybeAutoBan(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClientSafe>>,
  userId: string,
  verdict: ModerationVerdict,
): Promise<void> {
  const minors = verdict.scores?.["sexual/minors"] ?? 0;
  if (verdict.tier !== 2 || minors < AUTO_BAN_MINORS_SCORE) return;

  // bans.issued_by is NOT NULL: the schema assumes a human signs off. An
  // automated ban is issued in the name of the moderation owner, who is
  // accountable for it and can lift it — rather than inventing a robot
  // identity that nobody answers for.
  const { data: policy } = await supabase
    .from("moderation_policy")
    .select("owner_user_id")
    .eq("id", 1)
    .maybeSingle();
  const issuedBy = policy?.owner_user_id as string | undefined;
  if (!issuedBy) return; // no owner configured — leave it to human review

  // For good. A running suspension is extended to that, not left to run out:
  // skipping it let this ban vanish when a 3-day suspension ended.
  await banUntil(supabase, {
    userId, issuedBy, expiresAt: null,
    reason: `Automated: sexual/minors ${minors.toFixed(2)} (automod ${verdict.promptHash.slice(0, 12)})`,
  });
  console.warn("[automod] auto-ban issued", { userId, minors });
}
