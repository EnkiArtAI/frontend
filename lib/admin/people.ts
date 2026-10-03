/**
 * The admin person list (Kev, 2026-10-03): one row per person who was warned,
 * blocked, suspended or whose generations failed this week, and on expanding a
 * row every event with its prompt and settings, to see who is failing on what
 * and fix it fast. Counts come from the same rules enforcement uses, so the
 * list shows exactly what suspends.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { warningWeight } from "@/lib/moderation/warnings";
import { EXTRACTION_WINDOW_MS } from "@/lib/moderation/extraction-hits";

/** Categories that flag a child-safety case; only an admin may overturn one. */
export const CHILD_SAFETY = ["minor_sexual", "sexual/minors", "csam"];
const PEOPLE_LIMIT = 50;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Decrypt = (ct: unknown, iv: unknown, tag: unknown, kid: unknown) => string | null;
type Row = Record<string, unknown>;

export interface Person {
  userId: string;
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

const activeBan = () => `expires_at.is.null,expires_at.gt.${new Date().toISOString()}`;
const latest = (a: string | null, b: unknown) => (typeof b === "string" && (!a || b > a) ? b : a);

export async function listPeople(supabase: SupabaseClient): Promise<Person[]> {
  const weekAgo = new Date(Date.now() - WEEK_MS).toISOString();
  const [events, failures, bans] = await Promise.all([
    supabase.from("automod_events").select("user_id, created_at").eq("decision", "block")
      .not("user_id", "is", null).order("created_at", { ascending: false }).limit(1000),
    supabase.from("generation_failures").select("user_id, created_at").gte("created_at", weekAgo)
      .not("user_id", "is", null).order("created_at", { ascending: false }).limit(1000),
    supabase.from("bans").select("user_id, created_at").is("lifted_at", null).or(activeBan()).limit(200),
  ]);

  // The people with the most recent reason to look at them.
  const seen = new Map<string, string | null>();
  for (const r of [...(events.data ?? []), ...(failures.data ?? []), ...(bans.data ?? [])] as Row[]) {
    const id = String(r.user_id ?? "");
    if (id) seen.set(id, latest(seen.get(id) ?? null, r.created_at));
  }
  const ids = [...seen.entries()].sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, PEOPLE_LIMIT).map(([id]) => id);
  if (ids.length === 0) return [];

  const [ev, fl, gen, users, active] = await Promise.all([
    supabase.from("automod_events").select("user_id, category, scores, review_state, created_at")
      .in("user_id", ids).eq("decision", "block").limit(5000),
    supabase.from("generation_failures").select("user_id, created_at").in("user_id", ids).gte("created_at", weekAgo).limit(5000),
    supabase.from("generations").select("user_id, created_at").in("user_id", ids).order("created_at", { ascending: false }).limit(500),
    supabase.from("users").select("id, handle, display_name").in("id", ids),
    supabase.from("bans").select("user_id, expires_at").in("user_id", ids).is("lifted_at", null).or(activeBan()),
  ]);

  const extractionSince = new Date(Date.now() - EXTRACTION_WINDOW_MS).toISOString();
  const by = <T extends Row>(rows: T[] | null, id: string) => (rows ?? []).filter((r) => String(r.user_id) === id);
  const people = ids.map((id): Person => {
    const rows = by(ev.data as Row[] | null, id);
    const user = ((users.data ?? []) as Row[]).find((u) => String(u.id) === id);
    const ban = by(active.data as Row[] | null, id)[0];
    const live = rows.filter((r) => r.review_state !== "overturned");
    let lastActive: string | null = null;
    for (const r of [...rows, ...by(fl.data as Row[] | null, id), ...by(gen.data as Row[] | null, id)]) lastActive = latest(lastActive, r.created_at);
    return {
      userId: id,
      handle: (user?.handle as string | null) ?? null,
      displayName: (user?.display_name as string | null) ?? null,
      warnings: warningWeight(rows as Parameters<typeof warningWeight>[0]),
      extractionHits: live.filter((r) => r.category === "extraction" && String(r.created_at) >= extractionSince).length,
      childSafety: live.some((r) => CHILD_SAFETY.includes(String(r.category))),
      pending: rows.filter((r) => r.review_state === "pending").length,
      suspension: ban ? { until: (ban.expires_at as string | null) ?? null } : null,
      failed7d: by(fl.data as Row[] | null, id).length,
      lastActive,
    };
  });
  return people.sort((a, b) => String(b.lastActive ?? "").localeCompare(String(a.lastActive ?? "")));
}

export interface PersonDetail {
  events: {
    id: string; category: string | null; severity: string; tier: number | null; surface: string;
    rules: string[]; weight: number; confidence: number | null; prompt: string | null; state: string;
    reviewedAt: string | null; note: string | null; at: string;
  }[];
  failures: {
    id: string; surface: string; model: string | null; resolution: string | null; quality: string | null; boost: boolean;
    aspectRatio: string | null; referenceImageCount: number; error: string; prompt: string | null;
    imageUrl: string | null; txSignature: string | null; at: string;
  }[];
  bans: { id: string; reason: string | null; expiresAt: string | null; liftedAt: string | null; at: string }[];
}

export async function personDetail(supabase: SupabaseClient, userId: string, decrypt: Decrypt): Promise<PersonDetail> {
  const [ev, fl, bans] = await Promise.all([
    supabase.from("automod_events")
      .select("id, surface, severity, tier, category, matched_rules, scores, evidence_ct, evidence_iv, evidence_tag, evidence_kid, review_state, reviewed_at, review_notes, created_at")
      .eq("user_id", userId).eq("decision", "block").order("created_at", { ascending: false }).limit(100),
    supabase.from("generation_failures")
      .select("id, surface, model_id, resolution, quality, boost, aspect_ratio, reference_image_count, error, prompt_ct, prompt_iv, prompt_tag, prompt_kid, image_url, tx_signature, created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
    supabase.from("bans").select("id, reason, expires_at, lifted_at, created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
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
      return {
        id: String(r.id),
        category: (r.category as string | null) ?? null,
        severity: String(r.severity),
        tier: (r.tier as number | null) ?? null,
        surface: String(r.surface),
        rules: Array.isArray(r.matched_rules) ? (r.matched_rules as string[]) : [],
        weight: Number(scores.weight) || 0,
        confidence: typeof scores.confidence === "number" ? scores.confidence : typeof scores.extraction === "number" ? scores.extraction : null,
        prompt: decrypt(r.evidence_ct, r.evidence_iv, r.evidence_tag, r.evidence_kid),
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
