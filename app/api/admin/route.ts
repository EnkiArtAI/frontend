/**
 * Admin panel API — the ONLY door to moderation data.
 *
 *   GET  → one payload for every tab (imports, reports, feedback, friends,
 *          hunters, strikes+bans+appeals, recovery). Small beta-scale lists.
 *   POST → { resource, action, ... } mutations, each scoped + audited via
 *          decided_by/issued_by columns.
 *
 * Server-side gate on EVERY request: session → users.role ∈ {admin, mod}.
 * (The client gate in /admin is cosmetic — this check is the real wall.)
 * All tables verified live 2026-07-20 via PostgREST OpenAPI probe; check
 * constraints verified live 2026-07-21 via probe inserts:
 *   strikes.severity ∈ {1,2,3} · bans.scope ∈ {full} · appeals.status ∈
 *   {pending,approved,denied,withdrawn} · appeals.target_type ∈ {strike,ban} ·
 *   reports.status ∈ {pending,actioned,dismissed,duplicate} · reports.reason ∈
 *   {spam,copyright,hate,impersonation,other}
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { decryptString, encryptString, type EncryptedPayload } from "@/lib/crypto";
import { notifyAdmins } from "@/lib/admin-notify";
import { CHILD_SAFETY, hasChildSafetyCase, listPeople, parsePersonKey, personDetail } from "@/lib/admin/people";
import { banUntil } from "@/lib/moderation/bans";

/** A ban counts while it is not lifted and has not run out, as activeBanFor reads it. */
const unexpired = () => `expires_at.is.null,expires_at.gt.${new Date().toISOString()}`;

type Supabase = ReturnType<typeof getSupabaseServerClient>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The role comes back too: mods and admins share this panel, but not every
// control in it. Throttling generation is an admin decision — a mod moderates
// content, and must not be able to slow the product down for everyone.
async function requireAdmin(
  supabase: Supabase,
  req: NextRequest,
): Promise<{ userId: string; role: string } | NextResponse> {
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { data } = await supabase.from("users").select("role").eq("id", userId).maybeSingle();
  const role = (data?.role as string) ?? "user";
  if (role !== "admin" && role !== "mod") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  return { userId, role };
}

/** Tolerant field decrypt: encrypted columns may use no AAD or an id AAD. */
function tryDecrypt(ct: unknown, iv: unknown, tag: unknown, kid: unknown, aads: (string | undefined)[]): string | null {
  if (typeof ct !== "string" || typeof iv !== "string" || typeof tag !== "string" || !ct) return null;
  const payload: EncryptedPayload = { encrypted: ct, iv, authTag: tag, kid: typeof kid === "string" ? kid : undefined };
  for (const aad of aads) {
    try { return decryptString(payload, aad); } catch { /* try next */ }
  }
  return null;
}

const handleMap = async (supabase: Supabase, ids: string[]): Promise<Map<string, string>> => {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const { data } = await supabase.from("users").select("id, handle").in("id", uniq);
  return new Map((data ?? []).map((u) => [String(u.id), (u.handle as string) ?? "unnamed"]));
};

/* ── moderation council (tables from migrations/2026-07-21-moderation-council.sql;
      every read tolerates the migration not having run yet) ── */

type ProposalRow = Record<string, unknown>;
type CouncilPayload = {
  ready: boolean; isOwner: boolean; enabled: boolean; quorum: number; ttlDays: number;
  members: { handle: string; role: string; hasEmail: boolean }[];
  myEmail: string | null;
  proposals: {
    id: string; kind: string; target: string; targetUserId: string | null; days: number | null;
    violation: string; proposer: string; status: string; confirms: number; denies: number;
    myVote: string | null; quorum: number; at: string; expiresAt: string;
  }[];
};

async function buildCouncil(supabase: Supabase, userId: string): Promise<CouncilPayload> {
  const off: CouncilPayload = { ready: false, isOwner: false, enabled: false, quorum: 3, ttlDays: 7, members: [], myEmail: null, proposals: [] };
  const { data: policy, error } = await supabase.from("moderation_policy")
    .select("owner_user_id, council_enabled, quorum, proposal_ttl_days").eq("id", 1).maybeSingle();
  if (error || !policy) return off;

  const nowIso = new Date().toISOString();
  await supabase.from("mod_proposals").update({ status: "expired", decided_at: nowIso })
    .eq("status", "pending").lt("expires_at", nowIso);

  const [membersQ, prefsQ, propsQ] = await Promise.all([
    supabase.from("users").select("id, handle, role").in("role", ["admin", "mod"]).is("deleted_at", null),
    supabase.from("admin_prefs").select("user_id, notify_email_ct, notify_email_iv, notify_email_tag, notify_email_kid"),
    supabase.from("mod_proposals").select("*").order("created_at", { ascending: false }).limit(60),
  ]);
  const prefs = new Map((prefsQ.data ?? []).map((p) => [String(p.user_id), p]));
  const props = (propsQ.data ?? []) as ProposalRow[];
  const ids = props.map((p) => String(p.id));
  const votes = ids.length
    ? ((await supabase.from("mod_proposal_votes").select("proposal_id, voter_user_id, vote").in("proposal_id", ids)).data ?? [])
    : [];
  const tally = new Map<string, { c: number; d: number; mine: string | null }>();
  for (const v of votes) {
    const k = String(v.proposal_id);
    const t = tally.get(k) ?? { c: 0, d: 0, mine: null };
    if (v.vote === "confirm") t.c++; else t.d++;
    if (String(v.voter_user_id) === userId) t.mine = String(v.vote);
    tally.set(k, t);
  }
  const handles = await handleMap(supabase, [
    ...props.map((p) => (p.target_user_id ? String(p.target_user_id) : "")),
    ...props.map((p) => String(p.proposed_by)),
  ]);
  const my = prefs.get(userId);
  return {
    ready: true,
    isOwner: String(policy.owner_user_id) === userId,
    enabled: policy.council_enabled === true,
    quorum: Number(policy.quorum) || 3,
    ttlDays: Number(policy.proposal_ttl_days) || 7,
    members: (membersQ.data ?? []).map((m) => ({
      handle: (m.handle as string) ?? "unnamed",
      role: String(m.role),
      hasEmail: !!prefs.get(String(m.id))?.notify_email_ct,
    })),
    myEmail: my ? tryDecrypt(my.notify_email_ct, my.notify_email_iv, my.notify_email_tag, my.notify_email_kid, [userId, undefined]) : null,
    proposals: props.map((p) => {
      const t = tally.get(String(p.id)) ?? { c: 0, d: 0, mine: null };
      return {
        id: String(p.id), kind: String(p.kind),
        target: p.target_user_id ? "@" + (handles.get(String(p.target_user_id)) ?? "unknown") : "IP " + String(p.target_ip_hash).slice(0, 10) + "…",
        targetUserId: p.target_user_id ? String(p.target_user_id) : null,
        days: (p.days as number | null) ?? null,
        violation: String(p.violation ?? ""),
        proposer: handles.get(String(p.proposed_by)) ?? "unknown",
        status: String(p.status), confirms: t.c, denies: t.d, myVote: t.mine,
        quorum: Number(p.quorum), at: String(p.created_at), expiresAt: String(p.expires_at),
      };
    }),
  };
}

/** Newest hashed login IP for a user (sessions are keyed by user id or wallet). */
async function lastKnownIpHash(supabase: Supabase, targetUserId: string): Promise<string | null> {
  const { data: wallets } = await supabase.from("user_wallets").select("address").eq("user_id", targetUserId);
  const keys = [targetUserId, ...(wallets ?? []).map((w) => String(w.address))];
  const { data } = await supabase.from("auth_sessions")
    .select("ip_hash").in("wallet_address", keys).not("ip_hash", "is", null)
    .order("created_at", { ascending: false }).limit(1);
  return (data?.[0]?.ip_hash as string) ?? null;
}

/** Quorum reached → the proposal's action lands in bans/ip_bans. */
async function executeProposal(supabase: Supabase, p: ProposalRow, now: string): Promise<{ message?: string } | null> {
  const reason = `Council: ${String(p.violation)}`.slice(0, 200);
  if (p.kind === "ip_ban") {
    const { error } = await supabase.from("ip_bans").upsert({
      ip_hash: String(p.target_ip_hash), reason, issued_by: String(p.proposed_by), proposal_id: String(p.id),
    }, { onConflict: "ip_hash", ignoreDuplicates: true });
    if (error) return error;
  } else {
    const until = p.kind === "ban_perm" ? null : new Date(Date.now() + Number(p.days ?? 7) * 86400_000).toISOString();
    // Its own row when it ends later than a running ban (lib/moderation/bans.ts),
    // so each keeps its reason and appeal; nothing new when it ends no later.
    const issued = await banUntil(supabase, {
      userId: String(p.target_user_id), issuedBy: String(p.proposed_by), reason, expiresAt: until,
    }).catch(() => null);
    if (!issued) return { message: "the ban could not be issued" };
  }
  const { error } = await supabase.from("mod_proposals")
    .update({ status: "approved", decided_at: now, executed_at: now }).eq("id", String(p.id));
  return error ?? null;
}

/** Email every council member with a saved notify address (except the proposer). */
async function notifyCouncil(supabase: Supabase, proposerId: string, p: { kind: string; days: number | null; violation: string; targetHandle: string; quorum: number }) {
  const { data: proposer } = await supabase.from("users").select("handle").eq("id", proposerId).maybeSingle();
  const label = p.kind === "ip_ban" ? "indefinite IP ban" : p.kind === "ban_perm" ? "permanent ban" : `${p.days ?? 7}-day ban`;
  const origin = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_ORIGIN || "";
  await notifyAdmins(supabase, {
    exceptUserId: proposerId,
    subject: `[Enki Admin] Council vote: ${label} for @${p.targetHandle}`,
    text: [
      `@${(proposer?.handle as string) ?? "an admin"} proposes a ${label} against @${p.targetHandle}.`,
      "",
      `Violation: ${p.violation}`,
      "",
      `Confirm or deny in the admin panel (Council tab)${origin ? `: ${origin}/admin` : "."}`,
      `The action executes at ${p.quorum} confirmations.`,
    ].join("\n"),
  });
}

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const gate = await requireAdmin(supabase, req);
  if (gate instanceof NextResponse) return gate;
  const { userId, role } = gate;

  // One person, expanded in the person list: every event with its prompt and settings.
  const person = req.nextUrl.searchParams.get("person");
  if (person !== null) {
    const who = parsePersonKey(person);
    if (!who) return NextResponse.json({ error: "Bad person id" }, { status: 400 });
    return NextResponse.json(await personDetail(supabase, who, (ct, iv, tag, kid) => tryDecrypt(ct, iv, tag, kid, [undefined])));
  }

  const [imp, rep, fb, fr, hu, st, ba, ap, rec, council, genPolicy, automod, people] = await Promise.all([
    supabase.from("hunt_submissions")
      .select("id, hunter_user_id, source_url, suggested_title, suggested_tags, submitted_at")
      .eq("status", "pending").order("submitted_at", { ascending: false }).limit(100),
    supabase.from("reports")
      .select("id, reporter_user_id, target_type, target_uuid, reason, details, severity, status, created_at")
      .eq("status", "pending").order("created_at", { ascending: false }).limit(100),
    supabase.from("feedback_submissions")
      .select("id, user_id, submitter_name, submitter_email_ct, submitter_email_iv, submitter_email_tag, submitter_email_kid, description, category, severity, payout_cents, paid_at, created_at")
      .order("created_at", { ascending: false }).limit(100),
    supabase.from("friends_whitelist")
      .select("id, label, address, address_type, chain_key, notes, added_at")
      .eq("is_active", true).order("added_at", { ascending: false }).limit(200),
    supabase.from("hunter_stats")
      .select("user_id, total_submissions, approved_count, rejected_count, duplicate_count, earnings_cents")
      .order("approved_count", { ascending: false }).limit(50),
    supabase.from("strikes")
      .select("id, user_id, reason, severity, created_at")
      .is("revoked_at", null).order("created_at", { ascending: false }).limit(200),
    supabase.from("bans")
      .select("id, user_id, reason, scope, expires_at, created_at")
      // Longest last, so per user the ban that holds is the one kept below.
      .is("lifted_at", null).or(unexpired()).order("expires_at", { ascending: true, nullsFirst: false }).limit(100),
    supabase.from("appeals")
      .select("id, user_id, user_statement, status, target_uuid, created_at")
      .eq("status", "pending").order("created_at", { ascending: false }).limit(100),
    supabase.from("recovery_requests")
      .select("id, user_id, claimed_handle, claimed_wallet, contact_email_ct, contact_email_iv, contact_email_tag, contact_email_kid, explanation_ct, explanation_iv, explanation_tag, explanation_kid, layer, status, rejection_reason, created_at")
      .order("created_at", { ascending: false }).limit(50),
    buildCouncil(supabase, userId),
    supabase.from("generation_policy").select("max_concurrent_per_user").eq("id", 1).maybeSingle(),
    // Blocks only. Passes are recorded too (they are the control group for
    // tuning thresholds) but there is nothing for a moderator to do with
    // them, and at generation volume they would bury the real cases.
    supabase.from("automod_events")
      .select("id, user_id, surface, severity, tier, category, matched_rules, scores, prompt_hash, evidence_ct, evidence_iv, evidence_tag, evidence_kid, review_state, created_at")
      .eq("decision", "block")
      .order("created_at", { ascending: false }).limit(150),
    listPeople(supabase),
  ]);

  // attachments per feedback + evidence per recovery request
  const fbIds = (fb.data ?? []).map((r) => String(r.id));
  const recIds = (rec.data ?? []).map((r) => String(r.id));
  const [att, evi] = await Promise.all([
    fbIds.length ? supabase.from("feedback_attachments").select("feedback_id").in("feedback_id", fbIds) : Promise.resolve({ data: [] }),
    recIds.length ? supabase.from("recovery_request_evidence").select("request_id, kind, matched, value_url").in("request_id", recIds) : Promise.resolve({ data: [] }),
  ]);
  const attCount = new Map<string, number>();
  for (const a of (att.data ?? []) as { feedback_id: string }[]) {
    attCount.set(String(a.feedback_id), (attCount.get(String(a.feedback_id)) ?? 0) + 1);
  }
  const eviByReq = new Map<string, { kind: string; matched: boolean | null }[]>();
  for (const e of (evi.data ?? []) as { request_id: string; kind: string; matched: boolean | null }[]) {
    const k = String(e.request_id);
    (eviByReq.get(k) ?? eviByReq.set(k, []).get(k)!).push({ kind: e.kind, matched: e.matched });
  }

  // handles for hunters, strikes/bans/appeals users, reporters + report targets
  const strikeUsers = (st.data ?? []).map((r) => String(r.user_id));
  const banUsers = (ba.data ?? []).map((r) => String(r.user_id));
  const appealUsers = (ap.data ?? []).map((r) => String(r.user_id));
  const handles = await handleMap(supabase, [
    ...(imp.data ?? []).map((r) => String(r.hunter_user_id)),
    ...(hu.data ?? []).map((r) => String(r.user_id)),
    ...(rep.data ?? []).map((r) => String(r.reporter_user_id)),
    ...(rep.data ?? []).filter((r) => r.target_type !== "prompt").map((r) => String(r.target_uuid)),
    ...strikeUsers, ...banUsers, ...appealUsers,
    // automod events carry a user only when the request had a session;
    // /api/generate-free has none, so those rows stay attributed by IP hash.
    ...(automod.data ?? []).filter((r) => r.user_id).map((r) => String(r.user_id)),
  ]);
  const promptTargets = (rep.data ?? []).filter((r) => r.target_type === "prompt").map((r) => String(r.target_uuid));
  const promptTitles = new Map<string, string>();
  if (promptTargets.length) {
    const { data } = await supabase.from("prompts").select("id, title").in("id", promptTargets);
    for (const p of data ?? []) promptTitles.set(String(p.id), (p.title as string) ?? "Untitled");
  }

  // strikes tab: one row per user with active strikes, ban state and appeal
  // A user can hold several bans (each sanction is its own row); the one that
  // lasts longest holds, and is the one shown.
  const banByUser = new Map<string, { id: string; reason: string | null; permanent: boolean }>();
  for (const b of (ba.data ?? []) as { id: string; user_id: string; reason: string | null; expires_at: string | null }[]) {
    banByUser.set(String(b.user_id), { id: String(b.id), reason: b.reason, permanent: !b.expires_at });
  }
  // Of several pending appeals, the one against the ban that holds; else the newest.
  const appealByUser = new Map<string, { id: string; note: string | null; target: string | null }>();
  for (const a of (ap.data ?? []) as { id: string; user_id: string; user_statement: string | null; target_uuid: string | null }[]) {
    const k = String(a.user_id);
    const holding = banByUser.get(k)?.id;
    const cur = appealByUser.get(k);
    if (!cur || (a.target_uuid === holding && cur.target !== holding)) {
      appealByUser.set(k, { id: String(a.id), note: a.user_statement, target: a.target_uuid ?? null });
    }
  }
  const strikeRows = new Map<string, { userId: string; strikes: { id: string; reason: string | null }[] }>();
  for (const s of (st.data ?? []) as { id: string; user_id: string; reason: string | null }[]) {
    const k = String(s.user_id);
    (strikeRows.get(k) ?? strikeRows.set(k, { userId: k, strikes: [] }).get(k)!).strikes.push({ id: String(s.id), reason: s.reason });
  }
  for (const k of [...banByUser.keys(), ...appealByUser.keys()]) {
    if (!strikeRows.has(k)) strikeRows.set(k, { userId: k, strikes: [] });
  }

  return NextResponse.json({
    people,
    imports: (imp.data ?? []).map((r) => ({
      id: String(r.id),
      name: (r.suggested_title as string) || "Untitled",
      url: (r.source_url as string) ?? null,
      hunter: handles.get(String(r.hunter_user_id)) ?? "unknown",
      tags: Array.isArray(r.suggested_tags) ? (r.suggested_tags as string[]).slice(0, 4) : [],
      at: r.submitted_at,
    })),
    reports: (rep.data ?? []).map((r) => ({
      id: String(r.id),
      target: r.target_type === "prompt"
        ? (promptTitles.get(String(r.target_uuid)) ?? "Deleted prompt")
        : "@" + (handles.get(String(r.target_uuid)) ?? "unknown"),
      type: (r.target_type as string) === "prompt" ? "prompt" : "profile",
      reason: (r.reason as string) ?? "—",
      details: (r.details as string) ?? null,
      reporter: handles.get(String(r.reporter_user_id)) ?? "anon",
      severity: (r.severity as number | string | null) ?? null,
      at: r.created_at,
    })),
    feedback: (fb.data ?? []).map((r) => ({
      id: String(r.id),
      name: (r.submitter_name as string) || "Anonymous",
      email: tryDecrypt(r.submitter_email_ct, r.submitter_email_iv, r.submitter_email_tag, r.submitter_email_kid,
        [undefined, String(r.id), r.user_id ? String(r.user_id) : undefined]),
      desc: (r.description as string) ?? "",
      images: attCount.get(String(r.id)) ?? 0,
      paid: r.paid_at !== null,
      payoutCents: (r.payout_cents as number | null) ?? null,
      at: r.created_at,
    })),
    friends: (fr.data ?? []).map((r) => ({
      id: String(r.id),
      name: (r.label as string) ?? "—",
      address: (r.address as string) ?? "",
      type: (r.address_type as string) ?? "EOA",
      chain: (r.chain_key as string) ?? "solana",
      notes: (r.notes as string) ?? null,
    })),
    hunters: (hu.data ?? []).map((r) => ({
      handle: handles.get(String(r.user_id)) ?? "unknown",
      total: (r.total_submissions as number) ?? 0,
      approved: (r.approved_count as number) ?? 0,
      denied: ((r.rejected_count as number) ?? 0) + ((r.duplicate_count as number) ?? 0),
      earningsCents: (r.earnings_cents as number) ?? 0,
    })),
    strikes: [...strikeRows.values()].map((row) => ({
      userId: row.userId,
      handle: handles.get(row.userId) ?? "unknown",
      strikes: row.strikes,
      banned: banByUser.has(row.userId),
      permanent: banByUser.get(row.userId)?.permanent ?? false,
      note: row.strikes[0]?.reason ?? banByUser.get(row.userId)?.reason ?? null,
      appeal: appealByUser.get(row.userId) ?? null,
    })),
    generation: {
      // Null is unlimited, and the UI must say so rather than showing a 0.
      maxConcurrentPerUser: (genPolicy.data?.max_concurrent_per_user as number | null) ?? null,
      // Mods see the number; only an admin may change it.
      canEdit: role === "admin",
    },
    automod: (automod.data ?? []).map((r) => {
      const scores = (r.scores as Record<string, number> | null) ?? null;
      // The single number a moderator needs: what the classifier was most
      // sure about. Everything else is in `scores` if they open the row.
      const worst = scores
        ? Object.entries(scores).sort((a, b) => b[1] - a[1])[0] ?? null
        : null;
      return {
        id: String(r.id),
        handle: r.user_id ? (handles.get(String(r.user_id)) ?? "unknown") : null,
        surface: (r.surface as string) ?? "?",
        severity: (r.severity as string) ?? "log",
        tier: (r.tier as number | null) ?? null,
        category: (r.category as string) ?? null,
        rules: Array.isArray(r.matched_rules) ? (r.matched_rules as string[]) : [],
        topScore: worst ? { name: worst[0], value: worst[1] } : null,
        // The blocked prompt itself. Encrypted at rest; a moderator judging a
        // block has to be able to read what was actually written.
        prompt: tryDecrypt(r.evidence_ct, r.evidence_iv, r.evidence_tag, r.evidence_kid, [undefined]),
        state: (r.review_state as string) ?? "none",
        at: r.created_at,
      };
    }),
    recovery: (rec.data ?? []).map((r) => ({
      id: String(r.id),
      handle: (r.claimed_handle as string) ?? "unknown",
      wallet: (r.claimed_wallet as string) ?? null,
      contact: tryDecrypt(r.contact_email_ct, r.contact_email_iv, r.contact_email_tag, r.contact_email_kid,
        [undefined, String(r.id), r.user_id ? String(r.user_id) : undefined]),
      explanation: tryDecrypt(r.explanation_ct, r.explanation_iv, r.explanation_tag, r.explanation_kid,
        [undefined, String(r.id), r.user_id ? String(r.user_id) : undefined]),
      evidence: eviByReq.get(String(r.id)) ?? [],
      layer: (r.layer as string | number | null) ?? null,
      status: (r.status as string) ?? "pending",
      at: r.created_at,
    })),
    council,
  });
}

export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const gate = await requireAdmin(supabase, req);
  if (gate instanceof NextResponse) return gate;
  const { userId, role } = gate;

  let body: {
    resource?: string; action?: string; id?: string; ids?: string[];
    reason?: string; name?: string; address?: string; type?: string; notes?: string; status?: string;
    userId?: string; severity?: number; days?: number; permanent?: boolean;
    maxConcurrentPerUser?: number | null;
    handle?: string; kind?: string; violation?: string; vote?: string;
    email?: string; enabled?: boolean; quorum?: number; ttlDays?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const now = new Date().toISOString();
  const fail = (e: { message?: string } | null, what: string) =>
    NextResponse.json({ error: `Could not ${what}${e?.message ? ": " + e.message : ""}` }, { status: 500 });

  // ── pending imports ──
  if (body.resource === "imports") {
    const ids = Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
    if (!ids.length) return NextResponse.json({ error: "id required" }, { status: 400 });
    if (body.action === "approve") {
      const { error } = await supabase.from("hunt_submissions")
        .update({ status: "approved", decided_at: now, decided_by: userId })
        .in("id", ids).eq("status", "pending");
      return error ? fail(error, "approve") : NextResponse.json({ ok: true });
    }
    if (body.action === "reject") {
      const { error } = await supabase.from("hunt_submissions")
        .update({ status: "rejected", rejection_reason: (body.reason ?? "Other").slice(0, 200), decided_at: now, decided_by: userId })
        .in("id", ids).eq("status", "pending");
      return error ? fail(error, "reject") : NextResponse.json({ ok: true });
    }
  }

  // ── reports ──
  if (body.resource === "reports" && body.id) {
    if (body.action === "resolve" || body.action === "dismiss") {
      const { error } = await supabase.from("reports")
        .update({ status: body.action === "resolve" ? "actioned" : "dismissed", decided_by: userId, decided_at: now })
        .eq("id", body.id);
      return error ? fail(error, body.action) : NextResponse.json({ ok: true });
    }
    if (body.action === "strike" || body.action === "delist") {
      const { data: rep } = await supabase.from("reports")
        .select("target_type, target_uuid, reason, status").eq("id", body.id).maybeSingle();
      if (!rep || rep.status !== "pending") {
        return NextResponse.json({ error: "Report not found or already decided" }, { status: 400 });
      }
      if (body.action === "delist") {
        if (rep.target_type !== "prompt") return NextResponse.json({ error: "Only prompt reports can be delisted" }, { status: 400 });
        const { error } = await supabase.from("prompts")
          .update({ is_listed: false, delisted_at: now }).eq("id", rep.target_uuid);
        if (error) return fail(error, "delist the prompt");
      } else {
        // strike goes to the reported user; for prompt reports that's the creator
        let targetUserId = String(rep.target_uuid);
        if (rep.target_type === "prompt") {
          const { data: p } = await supabase.from("prompts").select("creator_id").eq("id", rep.target_uuid).maybeSingle();
          if (!p) return NextResponse.json({ error: "Prompt no longer exists — dismiss the report instead" }, { status: 400 });
          targetUserId = String(p.creator_id);
        }
        const severity = [1, 2, 3].includes(Number(body.severity)) ? Number(body.severity) : 1;
        const { error } = await supabase.from("strikes").insert({
          user_id: targetUserId, issued_by: userId, severity,
          reason: `Report: ${rep.reason}`,
          related_report_id: body.id, related_target_type: rep.target_type, related_target_uuid: rep.target_uuid,
        });
        if (error) return fail(error, "issue the strike");
      }
      const { error } = await supabase.from("reports")
        .update({ status: "actioned", decided_by: userId, decided_at: now })
        .eq("id", body.id).eq("status", "pending");
      return error ? fail(error, "close the report") : NextResponse.json({ ok: true });
    }
  }

  // ── feedback ──
  if (body.resource === "feedback" && body.action === "markPaid" && body.id) {
    const { data: cur } = await supabase.from("feedback_submissions").select("payout_cents").eq("id", body.id).maybeSingle();
    const { error } = await supabase.from("feedback_submissions")
      .update({ paid_at: now, payout_cents: cur?.payout_cents ?? 10000, reviewer_id: userId })
      .eq("id", body.id).is("paid_at", null);
    return error ? fail(error, "mark paid") : NextResponse.json({ ok: true });
  }

  // ── friends whitelist ──
  if (body.resource === "friends") {
    if (body.action === "add") {
      const label = (body.name ?? "").trim(), address = (body.address ?? "").trim();
      if (!label || !address) return NextResponse.json({ error: "Name and address are required" }, { status: 400 });
      const { data, error } = await supabase.from("friends_whitelist")
        .insert({
          label: label.slice(0, 80), address: address.slice(0, 120),
          address_type: ["EOA", "Collection", "Multi-sig"].includes(body.type ?? "") ? body.type : "EOA",
          notes: (body.notes ?? "").trim().slice(0, 200) || null,
          chain_key: "solana", is_active: true, added_by: userId,
        })
        .select("id").single();
      return error ? fail(error, "add the entry") : NextResponse.json({ ok: true, id: String(data.id) });
    }
    if (body.action === "remove" && body.id) {
      // soft delete — the row stays for the audit trail
      const { error } = await supabase.from("friends_whitelist").update({ is_active: false }).eq("id", body.id);
      return error ? fail(error, "remove the entry") : NextResponse.json({ ok: true });
    }
  }

  // ── moderation events: review from the person list (Kev, 2026-10-03) ──
  // Overturning takes a warning or hit out of every count; the event itself
  // stays, append-only. A child-safety case is an admin's call, never a mod's.
  if (body.resource === "automod" && body.id && (body.action === "overturn" || body.action === "uphold")) {
    const { data: ev } = await supabase.from("automod_events")
      .select("category").eq("id", body.id).eq("decision", "block").maybeSingle();
    if (!ev) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (CHILD_SAFETY.includes(String(ev.category)) && role !== "admin") {
      return NextResponse.json({ error: "Only an admin can review a child-safety case" }, { status: 403 });
    }
    const { error } = await supabase.from("automod_events").update({
      review_state: body.action === "overturn" ? "overturned" : "upheld",
      reviewed_by: userId, reviewed_at: now, review_notes: body.reason?.slice(0, 500) ?? null,
    }).eq("id", body.id);
    return error ? fail(error, "review the event") : NextResponse.json({ ok: true });
  }

  // ── strikes ──

  // Generation throttle — ADMIN ONLY. A mod moderates content; slowing the
  // whole product down for every user is not a moderation decision, and the
  // client-side hiding of this control is cosmetic. This is the real wall.
  if (body.resource === "generation" && body.action === "setConcurrency") {
    if (role !== "admin") {
      return NextResponse.json({ error: "Admins only" }, { status: 403 });
    }
    const raw = body.maxConcurrentPerUser;
    // null is unlimited and must stay expressible — it is the default, and a
    // huge number would look like a limit while behaving like none.
    const value = raw === null || raw === undefined ? null : Number(raw);
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 100)) {
      return NextResponse.json({ error: "Use a whole number from 1 to 100, or leave it empty for unlimited" }, { status: 400 });
    }
    const { error } = await supabase
      .from("generation_policy")
      .upsert({ id: 1, max_concurrent_per_user: value, updated_at: now, updated_by: userId });
    return error ? fail(error, "save the generation limit") : NextResponse.json({ ok: true, maxConcurrentPerUser: value });
  }

  if (body.resource === "strikes" && body.action === "revoke" && body.id) {
    const { error } = await supabase.from("strikes")
      .update({ revoked_at: now, revoked_by: userId, revoke_reason: "Revoked from the admin panel" })
      .eq("id", body.id).is("revoked_at", null);
    return error ? fail(error, "revoke the strike") : NextResponse.json({ ok: true });
  }

  // ── bans (scope 'full' is the only live-allowed value) ──
  if (body.resource === "bans" && (body.userId || body.handle)) {
    let targetId = body.userId ?? null;
    if (!targetId) {
      const { data } = await supabase.from("users")
        .select("id").eq("handle", String(body.handle).replace(/^@/, "").trim()).maybeSingle();
      if (!data) return NextResponse.json({ error: "User not found" }, { status: 400 });
      targetId = String(data.id);
    }
    if (body.action === "ban") {
      // council mode routes every ban through a proposal instead
      const { data: pol } = await supabase.from("moderation_policy")
        .select("council_enabled").eq("id", 1).maybeSingle();
      if (pol?.council_enabled === true) {
        return NextResponse.json({ error: "Council mode is on — propose the ban in the Council tab instead" }, { status: 409 });
      }
      const permanent = body.permanent === true;
      const days = Number.isInteger(body.days) && body.days! >= 1 && body.days! <= 365 ? body.days! : null;
      if (!permanent && !days) return NextResponse.json({ error: "days (1–365) or permanent required" }, { status: 400 });
      const until = permanent ? null : new Date(Date.now() + days! * 86400_000).toISOString();
      // Its own row when it ends later than a running ban, so each keeps its
      // reason and appeal; refused when a running ban already lasts as long.
      const issued = await banUntil(supabase, {
        userId: targetId, issuedBy: userId, reason: (body.reason ?? "Banned from the admin panel").slice(0, 200), expiresAt: until,
      }).catch(() => null);
      if (!issued) return fail(null, "ban the user");
      if (!issued.issued) {
        return NextResponse.json({ error: issued.until ? `Already banned until ${issued.until.slice(0, 10)}` : "Already banned for good" }, { status: 400 });
      }
      return NextResponse.json({ ok: true });
    }
    if (body.action === "lift") {
      // A ban that follows a child-safety case is an admin's to lift, like the case itself.
      if (role !== "admin" && (await hasChildSafetyCase(supabase, targetId))) {
        return NextResponse.json({ error: "Only an admin can lift a ban after a child-safety case" }, { status: 403 });
      }
      const { error } = await supabase.from("bans")
        .update({ lifted_at: now, lifted_by: userId, lifted_reason: "Reinstated from the admin panel" })
        .eq("user_id", targetId).is("lifted_at", null);
      return error ? fail(error, "reinstate the user") : NextResponse.json({ ok: true });
    }
  }

  // ── appeals ──
  if (body.resource === "appeals" && body.id && (body.action === "approve" || body.action === "deny")) {
    const { data: ap } = await supabase.from("appeals")
      .select("target_type, target_uuid, status").eq("id", body.id).maybeSingle();
    if (!ap || ap.status !== "pending") {
      return NextResponse.json({ error: "Appeal not found or already decided" }, { status: 400 });
    }
    const approve = body.action === "approve";
    if (approve && ap.target_type !== "strike" && role !== "admin") {
      const { data: ban, error: banErr } = await supabase.from("bans").select("user_id").eq("id", ap.target_uuid).maybeSingle();
      if (banErr) return fail(banErr, "check the appealed ban");
      if (ban && (await hasChildSafetyCase(supabase, String(ban.user_id)))) {
        return NextResponse.json({ error: "Only an admin can lift a ban after a child-safety case" }, { status: 403 });
      }
    }
    const { error } = await supabase.from("appeals")
      .update({ status: approve ? "approved" : "denied", decided_by: userId, decided_at: now })
      .eq("id", body.id).eq("status", "pending");
    if (error) return fail(error, "decide the appeal");
    if (approve) {
      // approving undoes the appealed strike/ban
      const { error: undo } = ap.target_type === "strike"
        ? await supabase.from("strikes")
            .update({ revoked_at: now, revoked_by: userId, revoke_reason: "Appeal approved" })
            .eq("id", ap.target_uuid).is("revoked_at", null)
        : await supabase.from("bans")
            .update({ lifted_at: now, lifted_by: userId, lifted_reason: "Appeal approved" })
            .eq("id", ap.target_uuid).is("lifted_at", null);
      if (undo) return fail(undo, `undo the appealed ${ap.target_type}`);
    }
    return NextResponse.json({ ok: true });
  }

  // ── my admin prefs: council notification email ──
  if (body.resource === "prefs" && body.action === "setEmail") {
    const email = (body.email ?? "").trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return NextResponse.json({ error: "That doesn't look like an email address" }, { status: 400 });
    }
    if (!email) {
      const { error } = await supabase.from("admin_prefs").delete().eq("user_id", userId);
      return error ? fail(error, "clear the email") : NextResponse.json({ ok: true });
    }
    const enc = encryptString(email, userId);
    const { error } = await supabase.from("admin_prefs").upsert({
      user_id: userId, notify_email_ct: enc.encrypted, notify_email_iv: enc.iv,
      notify_email_tag: enc.authTag, notify_email_kid: enc.kid ?? null, updated_at: now,
    }, { onConflict: "user_id" });
    return error ? fail(error, "save the email") : NextResponse.json({ ok: true });
  }

  // ── moderation policy (owner only) ──
  if (body.resource === "policy" && body.action === "set") {
    const { data: pol } = await supabase.from("moderation_policy").select("owner_user_id").eq("id", 1).maybeSingle();
    if (!pol) return NextResponse.json({ error: "Council isn't set up yet — run the moderation-council migration first" }, { status: 400 });
    if (String(pol.owner_user_id) !== userId) return NextResponse.json({ error: "Owner only" }, { status: 403 });
    const quorum = Number(body.quorum), ttl = Number(body.ttlDays);
    if (!Number.isInteger(quorum) || quorum < 1 || quorum > 20) return NextResponse.json({ error: "Quorum must be 1–20" }, { status: 400 });
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 30) return NextResponse.json({ error: "Expiry must be 1–30 days" }, { status: 400 });
    const { error } = await supabase.from("moderation_policy")
      .update({ council_enabled: body.enabled === true, quorum, proposal_ttl_days: ttl, updated_at: now })
      .eq("id", 1);
    return error ? fail(error, "save the policy") : NextResponse.json({ ok: true });
  }

  // ── council proposals ──
  if (body.resource === "council" && body.action === "propose") {
    const kind = String(body.kind ?? "");
    if (!["ban_temp", "ban_perm", "ip_ban"].includes(kind)) return NextResponse.json({ error: "Unknown action kind" }, { status: 400 });
    const violation = (body.violation ?? "").trim().slice(0, 300);
    if (!violation) return NextResponse.json({ error: "Name the violation — the council votes on it" }, { status: 400 });
    const { data: pol } = await supabase.from("moderation_policy")
      .select("council_enabled, quorum, proposal_ttl_days").eq("id", 1).maybeSingle();
    if (!pol) return NextResponse.json({ error: "Council isn't set up yet — run the moderation-council migration first" }, { status: 400 });

    let target: { id: string; handle: string } | null = null;
    const lookup = body.userId
      ? supabase.from("users").select("id, handle").eq("id", body.userId).maybeSingle()
      : supabase.from("users").select("id, handle").eq("handle", String(body.handle ?? "").replace(/^@/, "").trim()).maybeSingle();
    const { data: u } = await lookup;
    if (u) target = { id: String(u.id), handle: (u.handle as string) ?? "unnamed" };
    if (!target) return NextResponse.json({ error: "User not found" }, { status: 400 });

    let ipHash: string | null = null;
    if (kind === "ip_ban") {
      ipHash = await lastKnownIpHash(supabase, target.id);
      if (!ipHash) return NextResponse.json({ error: "No login IP on record for this user yet" }, { status: 400 });
    }
    const days = kind === "ban_temp"
      ? (Number.isInteger(body.days) && body.days! >= 1 && body.days! <= 365 ? body.days! : 7)
      : null;
    // council off → quorum 1: the proposer's own confirm executes immediately
    const quorum = pol.council_enabled === true ? Number(pol.quorum) : 1;
    const { data: prop, error } = await supabase.from("mod_proposals").insert({
      kind, target_user_id: target.id, target_ip_hash: ipHash, days, violation,
      proposed_by: userId, quorum,
      expires_at: new Date(Date.now() + Number(pol.proposal_ttl_days) * 86400_000).toISOString(),
    }).select("*").single();
    if (error || !prop) return fail(error, "create the proposal");
    await supabase.from("mod_proposal_votes").insert({ proposal_id: prop.id, voter_user_id: userId, vote: "confirm" });
    if (quorum <= 1) {
      const execErr = await executeProposal(supabase, prop as ProposalRow, now);
      return execErr ? fail(execErr, "execute the action") : NextResponse.json({ ok: true, executed: true });
    }
    await notifyCouncil(supabase, userId, { kind, days, violation, targetHandle: target.handle, quorum });
    return NextResponse.json({ ok: true, executed: false });
  }

  if (body.resource === "council" && body.action === "vote" && body.id) {
    const vote = body.vote === "confirm" ? "confirm" : body.vote === "deny" ? "deny" : null;
    if (!vote) return NextResponse.json({ error: "vote must be confirm or deny" }, { status: 400 });
    const { data: prop } = await supabase.from("mod_proposals").select("*").eq("id", body.id).maybeSingle();
    if (!prop || prop.status !== "pending") return NextResponse.json({ error: "Proposal not found or already decided" }, { status: 400 });
    if (new Date(String(prop.expires_at)).getTime() < Date.now()) {
      await supabase.from("mod_proposals").update({ status: "expired", decided_at: now }).eq("id", body.id);
      return NextResponse.json({ error: "Proposal expired" }, { status: 400 });
    }
    const { error: vErr } = await supabase.from("mod_proposal_votes").upsert({
      proposal_id: body.id, voter_user_id: userId, vote, voted_at: now,
    }, { onConflict: "proposal_id,voter_user_id" });
    if (vErr) return fail(vErr, "record the vote");
    const [{ data: votes }, { count: memberCount }] = await Promise.all([
      supabase.from("mod_proposal_votes").select("vote").eq("proposal_id", body.id),
      supabase.from("users").select("id", { count: "exact", head: true }).in("role", ["admin", "mod"]).is("deleted_at", null),
    ]);
    const confirms = (votes ?? []).filter((v) => v.vote === "confirm").length;
    const denies = (votes ?? []).length - confirms;
    const quorum = Number(prop.quorum);
    if (confirms >= quorum) {
      const execErr = await executeProposal(supabase, prop as ProposalRow, now);
      return execErr ? fail(execErr, "execute the approved action") : NextResponse.json({ ok: true, status: "approved", confirms, denies });
    }
    // denied once quorum is mathematically out of reach
    if (denies >= Math.max(1, (memberCount ?? 0) - quorum + 1)) {
      const { error } = await supabase.from("mod_proposals").update({ status: "denied", decided_at: now }).eq("id", body.id);
      return error ? fail(error, "deny the proposal") : NextResponse.json({ ok: true, status: "denied", confirms, denies });
    }
    return NextResponse.json({ ok: true, status: "pending", confirms, denies });
  }

  // ── recovery requests ──
  if (body.resource === "recovery" && body.action === "setStatus" && body.id) {
    const status = body.status ?? "";
    if (!["pending", "needs_info", "approved", "rejected"].includes(status)) {
      return NextResponse.json({ error: "Unknown status" }, { status: 400 });
    }
    const patch: Record<string, unknown> = { status };
    if (status === "approved" || status === "rejected") { patch.decided_by = userId; patch.decided_at = now; }
    if (status === "rejected") patch.rejection_reason = (body.reason ?? "Rejected from the admin panel").slice(0, 200);
    const { error } = await supabase.from("recovery_requests").update(patch).eq("id", body.id);
    return error ? fail(error, "update the request") : NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Bad request" }, { status: 400 });
}
