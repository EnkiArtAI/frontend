/**
 * The admin person list (Kev, 2026-10-03): one row per person who was warned,
 * blocked, suspended or whose generations failed this week, and on expanding a
 * row every event with its prompt and settings, to see who is failing on what
 * and fix it fast. Someone without an account (the free generator, an agent)
 * is a person too, named by their hashed address. Counts come from the very
 * functions enforcement uses, so the list shows exactly what suspends.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ADDRESS_WINDOW_MS, WARNING_WEIGHT, weightSince } from "@/lib/moderation/warnings";
import { hitsSince } from "@/lib/moderation/extraction-hits";
import { activeBanFor } from "@/lib/session-user";
import { readEvidence } from "@/lib/moderation/evidence";

/** Categories that flag a child-safety case; only an admin may overturn one or lift its ban. */
export const CHILD_SAFETY = ["minor_sexual", "sexual/minors", "csam"];

/**
 * The warning and ban list: warnings, extraction hits and any record behind
 * a ban. The one place an artist's withheld words may be opened, by the
 * moderation owner (Kev, 2026-10-03).
 */
export function inWarningOrBanList(r: { category?: unknown; ban_id?: unknown }): boolean {
  return Object.keys(WARNING_WEIGHT).includes(String(r.category)) || r.category === "extraction" || r.ban_id != null;
}
const PEOPLE_LIMIT = 50;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Decrypt = (ct: unknown, iv: unknown, tag: unknown, kid: unknown) => string | null;
type Row = Record<string, unknown>;
type Who = { userId: string } | { ipHash: string };
type Filterable<Q> = { filter(column: string, operator: string, value: unknown): Q };

export interface Person {
  /** The account id, or "ip:<hash>" for someone without an account. */
  key: string;
  userId: string | null;
  ipHash: string | null;
  handle: string | null;
  displayName: string | null;
  warnings: number;
  extractionHits: number;
  childSafety: boolean;
  pending: number;
  suspension: { until: string | null } | null;
  failed7d: number;
  lastActive: string | null;
}

/** An account id, or "ip:<hash>" for someone without an account; anything else is no person. */
export function parsePersonKey(key: string): Who | null {
  if (UUID_RE.test(key)) return { userId: key };
  const m = /^ip:([0-9a-f]{16,128})$/.exec(key);
  return m ? { ipHash: m[1] } : null;
}

/** One person's rows: an account's own, or an address's rows that carry no account. */
function scope<Q extends Filterable<Q>>(q: Q, who: Who): Q {
  return "userId" in who ? q.filter("user_id", "eq", who.userId) : q.filter("user_id", "is", null).filter("ip_hash", "eq", who.ipHash);
}

const count = async (q: PromiseLike<{ count: number | null }>) => (await q).count ?? 0;


/** A child-safety case that was not overturned: lifting this user's ban is an admin's call. */
export async function hasChildSafetyCase(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { count: n, error } = await supabase.from("automod_events").select("id", { count: "exact", head: true })
    .eq("user_id", userId).in("category", CHILD_SAFETY).neq("review_state", "overturned");
  // A read that failed counts as a case: lifting is refused, never allowed blind.
  return Boolean(error) || (n ?? 0) > 0;
}

export async function listPeople(supabase: SupabaseClient): Promise<Person[]> {
  // Open cases first, then whoever was active last. The grouping happens in
  // SQL (view moderation_people, migrations/2026-10-03-generation-failures.sql),
  // so one busy account can never push anyone else off the list.
  const { data } = await supabase.from("moderation_people")
    .select("user_id, ip_hash, last_at, pending")
    .order("pending", { ascending: false }).order("last_at", { ascending: false }).limit(PEOPLE_LIMIT);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];

  const userIds = rows.map((r) => r.user_id).filter((id): id is string => typeof id === "string");
  const { data: users } = userIds.length
    ? await supabase.from("users").select("id, handle, display_name").in("id", userIds)
    : { data: [] as Row[] };
  const weekAgo = new Date(Date.now() - WEEK_MS).toISOString();

  return Promise.all(rows.map(async (r): Promise<Person> => {
    const who: Who = typeof r.user_id === "string" ? { userId: r.user_id } : { ipHash: String(r.ip_hash) };
    const id = "userId" in who ? { userId: who.userId, ipHash: null } : { userId: null, ipHash: who.ipHash };
    const events = () => scope(supabase.from("automod_events").select("id", { count: "exact", head: true }).eq("decision", "block"), who);
    const [warnings, extractionHits, pending, childSafety, failed7d, ban] = await Promise.all([
      // An address is judged over 30 days, as addressWarnedOut judges it.
      weightSince(supabase, id, id.userId ? undefined : new Date(Date.now() - ADDRESS_WINDOW_MS).toISOString()),
      hitsSince(supabase, id),
      count(events().eq("review_state", "pending")),
      count(events().in("category", CHILD_SAFETY).neq("review_state", "overturned")),
      count(scope(supabase.from("generation_failures").select("id", { count: "exact", head: true }).gte("created_at", weekAgo), who)),
      // One unreachable read must not take the whole admin panel down with it.
      id.userId ? activeBanFor(supabase, id.userId).catch(() => null) : Promise.resolve(null),
    ]);
    const user = ((users ?? []) as Row[]).find((u) => u.id === id.userId);
    return {
      key: id.userId ?? `ip:${id.ipHash}`,
      ...id,
      handle: (user?.handle as string | null) ?? null,
      displayName: (user?.display_name as string | null) ?? null,
      warnings,
      extractionHits,
      childSafety: childSafety > 0,
      pending,
      suspension: ban ? { until: ban.expiresAt } : null,
      failed7d,
      lastActive: (r.last_at as string | null) ?? null,
    };
  }));
}

export interface PersonDetail {
  events: {
    id: string; category: string | null; severity: string; tier: number | null; surface: string;
    rules: string[]; weight: number; confidence: number | null; prompt: string | null; withheld: boolean; draft: boolean; revealable: boolean; state: string;
    reviewedAt: string | null; note: string | null; at: string;
  }[];
  failures: {
    id: string; surface: string; model: string | null; resolution: string | null; quality: string | null; boost: boolean;
    aspectRatio: string | null; referenceImageCount: number; error: string; prompt: string | null; draft: boolean;
    imageUrl: string | null; txSignature: string | null; at: string;
  }[];
  bans: { id: string; reason: string | null; expiresAt: string | null; liftedAt: string | null; at: string }[];
}

export async function personDetail(supabase: SupabaseClient, who: Who, decrypt: Decrypt): Promise<PersonDetail> {
  const [ev, fl, bans] = await Promise.all([
    scope(supabase.from("automod_events")
      .select("id, surface, severity, tier, category, matched_rules, scores, ban_id, evidence_ct, evidence_iv, evidence_tag, evidence_kid, review_state, reviewed_at, review_notes, created_at")
      .eq("decision", "block"), who).order("created_at", { ascending: false }).limit(100),
    scope(supabase.from("generation_failures")
      .select("id, surface, model_id, resolution, quality, boost, aspect_ratio, reference_image_count, error, prompt_ct, prompt_iv, prompt_tag, prompt_kid, image_url, tx_signature, created_at"),
    who).order("created_at", { ascending: false }).limit(50),
    "userId" in who
      ? supabase.from("bans").select("id, reason, expires_at, lifted_at, created_at")
        .eq("user_id", who.userId).order("created_at", { ascending: false }).limit(20)
      : Promise.resolve({ data: [] as Row[] }),
  ]);
  const failures = (fl.data ?? []) as Row[];
  const modelIds = [...new Set(failures.map((f) => f.model_id).filter((m): m is string => typeof m === "string"))];
  const { data: models } = modelIds.length
    ? await supabase.from("models").select("id, name").in("id", modelIds)
    : { data: [] as Row[] };
  const modelName = new Map(((models ?? []) as Row[]).map((m) => [String(m.id), String(m.name)]));

  return {
    events: ((ev.data ?? []) as Row[]).map((r) => {
      const scores = (r.scores ?? {}) as Record<string, unknown>;
      // Never an artist's words (lib/moderation/evidence).
      const evidence = readEvidence(r);
      return {
        id: String(r.id),
        category: (r.category as string | null) ?? null,
        severity: String(r.severity),
        tier: (r.tier as number | null) ?? null,
        surface: String(r.surface),
        rules: Array.isArray(r.matched_rules) ? (r.matched_rules as string[]) : [],
        weight: Number(scores.weight) || 0,
        confidence: typeof scores.confidence === "number" ? scores.confidence : typeof scores.extraction === "number" ? scores.extraction : null,
        prompt: evidence.text,
        withheld: evidence.withheld,
        draft: evidence.draft,
        revealable: evidence.withheld && inWarningOrBanList(r),
        state: String(r.review_state),
        reviewedAt: (r.reviewed_at as string | null) ?? null,
        note: (r.review_notes as string | null) ?? null,
        at: String(r.created_at),
      };
    }),
    failures: failures.map((r) => ({
      id: String(r.id),
      surface: String(r.surface),
      model: typeof r.model_id === "string" ? modelName.get(r.model_id) ?? r.model_id : null,
      resolution: (r.resolution as string | null) ?? null,
      quality: (r.quality as string | null) ?? null,
      boost: r.boost === true,
      aspectRatio: (r.aspect_ratio as string | null) ?? null,
      referenceImageCount: Number(r.reference_image_count) || 0,
      error: String(r.error ?? ""),
      prompt: decrypt(r.prompt_ct, r.prompt_iv, r.prompt_tag, r.prompt_kid),
      // A signed-in requester's editor draft is stored without its text.
      draft: r.prompt_ct == null,
      imageUrl: (r.image_url as string | null) ?? null,
      txSignature: (r.tx_signature as string | null) ?? null,
      at: String(r.created_at),
    })),
    bans: ((bans.data ?? []) as Row[]).map((b) => ({
      id: String(b.id),
      reason: (b.reason as string | null) ?? null,
      expiresAt: (b.expires_at as string | null) ?? null,
      liftedAt: (b.lifted_at as string | null) ?? null,
      at: String(b.created_at),
    })),
  };
}
