/**
 * GET /api/analytics/me → the signed-in user's own performance.
 *
 * Everything is DERIVED from live tables (verified 2026-07-12) — no counter
 * tables: prompt_purchases is the receipt-per-sale ledger (sum = earnings),
 * prompts (creator_id, price_usd_cents, is_free_showcase, listing_status),
 * generations (prompt_id) for per-prompt generation counts.
 *
 * Response:
 *   summary: totals + earnings per day/week/month/year, each with a trend %
 *            vs the PREVIOUS same-length period (null when previous = 0)
 *   prompts: per-prompt rows for the Analytics table (earnings, sales,
 *            generations; views/rating/comments are null until tracking
 *            tables exist — no fake numbers).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { isPublicText } from "@/lib/prompt-visibility";

const DAY_MS = 24 * 60 * 60 * 1000;

function sumBetween(rows: { cents: number; at: number }[], from: number, to: number): number {
  let s = 0;
  for (const r of rows) if (r.at >= from && r.at < to) s += r.cents;
  return s;
}

/** % change vs previous period; null when there's nothing to compare against. */
function trend(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // My prompts + my completed sales + generations on my prompts — three reads.
  // prompts.views exists only after 2026-07-12-prompt-engagement.sql ran —
  // degrade to a views-less select instead of failing.
  type PromptRow = {
    id: unknown; title?: string | null; prompt_type?: string | null; is_free_showcase?: boolean | null;
    price_usd_cents?: number | null; listing_status?: string | null; created_at?: string;
    views?: number | null; opens?: number | null;
  };
  // ?summary=1 → totals + recent sales only (the Payment tab): skips the
  // per-prompt joins entirely — noticeably faster than the full table load.
  const summaryOnly = req.nextUrl.searchParams.get("summary") === "1";
  // showcase_images verified live 2026-07-20 (jsonb) — feeds the top-prompt thumbs.
  const baseCols = "id, title, prompt_type, is_free_showcase, price_usd_cents, listing_status, created_at, showcase_images";
  // Prompts + sales in parallel — they don't depend on each other.
  const [primary, salesRes] = await Promise.all([
    supabase.from("prompts").select(`${baseCols}, views, opens`).eq("creator_id", userId),
    supabase
      .from("prompt_purchases")
      .select("prompt_id, amount_usd_cents, created_at")
      .eq("seller_id", userId)
      .eq("status", "completed"),
  ]);
  const fallback = primary.error
    ? await supabase.from("prompts").select(baseCols).eq("creator_id", userId)
    : null;
  const myPrompts = ((fallback ? fallback.data : primary.data) ?? []) as PromptRow[];
  const pErr = fallback ? fallback.error : null;
  const { data: sales, error: sErr } = salesRes;
  if (pErr || sErr) {
    console.error("[analytics/me] load failed:", pErr?.message || sErr?.message);
    return NextResponse.json({ error: "Failed to load analytics" }, { status: 500 });
  }

  const promptIds = (myPrompts ?? []).map((p) => String(p.id));
  const genCounts = new Map<string, number>();
  const commentStats = new Map<string, { count: number; sum: number; rated: number }>();
  // Timestamped events for charts + the activity feed (all real, no fakes).
  const genRows: { promptId: string; at: number }[] = [];
  const reviewRows: { promptId: string; rating: number | null; at: number }[] = [];
  const viewCounts = new Map<string, number>();
  let viewsTotal = 0, viewsAvailable = false;
  if (promptIds.length > 0 && !summaryOnly) {
    const [{ data: gens }, comments, reviews, views] = await Promise.all([
      supabase.from("generations").select("prompt_id, created_at").in("prompt_id", promptIds).is("deleted_at", null).limit(20000),
      supabase.from("prompt_comments").select("prompt_id, rating").in("prompt_id", promptIds),
      // prompt_reviews verified live 2026-07-20 (rating, created_at, deleted_at, status)
      supabase.from("prompt_reviews").select("prompt_id, rating, created_at").in("prompt_id", promptIds)
        .is("deleted_at", null).order("created_at", { ascending: false }).limit(200),
      // views: 'view' events on my prompts (empty until tracking feeds it — no fakes)
      supabase.from("prompt_analytics_events").select("prompt_id").eq("creator_id", userId).eq("event_type", "view").limit(50000),
    ]);
    for (const g of gens ?? []) {
      const k = String(g.prompt_id);
      genCounts.set(k, (genCounts.get(k) ?? 0) + 1);
      genRows.push({ promptId: k, at: new Date(g.created_at as string).getTime() });
    }
    // prompt_comments may not be migrated yet → comments.error → stays empty.
    for (const c of comments.data ?? []) {
      const k = String(c.prompt_id);
      const s = commentStats.get(k) ?? { count: 0, sum: 0, rated: 0 };
      s.count += 1;
      if (typeof c.rating === "number") { s.sum += c.rating; s.rated += 1; }
      commentStats.set(k, s);
    }
    for (const r of reviews.data ?? []) {
      reviewRows.push({
        promptId: String(r.prompt_id),
        rating: typeof r.rating === "number" ? r.rating : null,
        at: new Date(r.created_at as string).getTime(),
      });
    }
    if (!views.error) {
      viewsAvailable = true;
      for (const v of views.data ?? []) {
        const k = String(v.prompt_id);
        viewCounts.set(k, (viewCounts.get(k) ?? 0) + 1);
        viewsTotal += 1;
      }
    }
  }

  // ── Summary: totals + period sums with trends vs the previous period ──────
  const saleRows = (sales ?? []).map((s) => ({
    cents: typeof s.amount_usd_cents === "number" ? s.amount_usd_cents : 0,
    at: new Date(s.created_at as string).getTime(),
    promptId: String(s.prompt_id),
  }));
  const now = Date.now();
  const period = (days: number) => {
    const cur = sumBetween(saleRows, now - days * DAY_MS, now);
    const prev = sumBetween(saleRows, now - 2 * days * DAY_MS, now - days * DAY_MS);
    return { cents: cur, trendPct: trend(cur, prev) };
  };

  const summary = {
    totalCents: saleRows.reduce((s, r) => s + r.cents, 0),
    salesCount: saleRows.length,
    day: period(1),
    week: period(7),
    month: period(30),
    year: period(365),
  };

  // ── Per-prompt table rows ──────────────────────────────────────────────────
  const earningsByPrompt = new Map<string, { cents: number; sales: number }>();
  for (const r of saleRows) {
    const e = earningsByPrompt.get(r.promptId) ?? { cents: 0, sales: 0 };
    e.cents += r.cents;
    e.sales += 1;
    earningsByPrompt.set(r.promptId, e);
  }

  const prompts = summaryOnly ? [] : (myPrompts ?? []).map((p) => {
    const id = String(p.id);
    const isFree = isPublicText(p) || (typeof p.price_usd_cents === "number" ? p.price_usd_cents : 0) === 0;
    const e = earningsByPrompt.get(id);
    return {
      id,
      title: p.title ?? "Untitled",
      type: (isFree ? "free" : "paid") as "free" | "paid",
      priceCents: typeof p.price_usd_cents === "number" ? p.price_usd_cents : 0,
      listingStatus: p.listing_status ?? null,
      createdAt: p.created_at,
      earningsCents: e?.cents ?? 0,
      sales: e?.sales ?? 0,
      generations: genCounts.get(id) ?? 0,
      // Live once 2026-07-12-prompt-engagement.sql ran; null (UI: "—") before.
      views: typeof p.views === "number" ? p.views : null,
      opens: typeof p.opens === "number" ? p.opens : null,
      rating: (() => {
        const s = commentStats.get(id);
        return s && s.rated > 0 ? Math.round((s.sum / s.rated) * 10) / 10 : null;
      })(),
      comments: commentStats.get(id)?.count ?? 0,
      referralEarningsCents: null as number | null, // referral payouts not server-side yet
    };
  });

  // Last 5 receipts for the Payment tab's mini list.
  const titleById = new Map((myPrompts ?? []).map((p) => [String(p.id), p.title ?? "Untitled"]));
  const recentSales = [...saleRows]
    .sort((a, b) => b.at - a.at)
    .slice(0, 5)
    .map((r, i) => ({
      id: `${r.promptId}-${r.at}-${i}`,
      promptTitle: titleById.get(r.promptId) ?? "Untitled",
      amountCents: r.cents,
      createdAt: new Date(r.at).toISOString(),
    }));

  // ── Analytics panel payload: charts, period stats, top prompts, activity ──
  const bucketSums = (
    rows: { at: number; v: number }[],
    edges: { from: number; to: number }[],
  ) => edges.map((e) => rows.reduce((s, r) => s + (r.at >= e.from && r.at < e.to ? r.v : 0), 0));
  const earnEvents = saleRows.map((r) => ({ at: r.at, v: r.cents }));
  const printEvents = genRows.map((r) => ({ at: r.at, v: 1 }));

  // week → 7 daily buckets; month → 4 equal buckets over 30d; all → calendar
  // months from the first activity (≤ 12), always at least the last two.
  const dayEdges = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now - (6 - i) * DAY_MS);
    d.setHours(0, 0, 0, 0);
    return { from: d.getTime(), to: d.getTime() + DAY_MS, label: d.toLocaleDateString("en-US", { weekday: "short" }) };
  });
  const weekEdges = Array.from({ length: 4 }, (_, i) => ({
    from: now - (4 - i) * 7.5 * DAY_MS, to: now - (3 - i) * 7.5 * DAY_MS, label: `W${i + 1}`,
  }));
  const firstAt = Math.min(...earnEvents.map((r) => r.at), ...printEvents.map((r) => r.at), now);
  const monthEdges: { from: number; to: number; label: string }[] = [];
  {
    const start = new Date(Math.max(firstAt, now - 365 * DAY_MS));
    const cur = new Date(start.getFullYear(), start.getMonth(), 1);
    const end = new Date();
    while (cur.getTime() <= end.getTime() && monthEdges.length < 12) {
      const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      monthEdges.push({ from: cur.getTime(), to: next.getTime(), label: cur.toLocaleDateString("en-US", { month: "short" }) });
      cur.setMonth(cur.getMonth() + 1);
    }
    while (monthEdges.length < 2) {
      const f = monthEdges[0] ?? { from: new Date(end.getFullYear(), end.getMonth(), 1).getTime() };
      const prev = new Date(f.from); prev.setMonth(prev.getMonth() - 1);
      monthEdges.unshift({ from: prev.getTime(), to: f.from, label: prev.toLocaleDateString("en-US", { month: "short" }) });
    }
  }
  const charts = {
    week: { labels: dayEdges.map((e) => e.label), earningsCents: bucketSums(earnEvents, dayEdges), prints: bucketSums(printEvents, dayEdges) },
    month: { labels: weekEdges.map((e) => e.label), earningsCents: bucketSums(earnEvents, weekEdges), prints: bucketSums(printEvents, weekEdges) },
    all: { labels: monthEdges.map((e) => e.label), earningsCents: bucketSums(earnEvents, monthEdges), prints: bucketSums(printEvents, monthEdges) },
  };

  // Period cards: current vs the previous same-length window (trend % or null).
  const countBetween = (rows: { at: number }[], from: number, to: number) =>
    rows.reduce((s, r) => s + (r.at >= from && r.at < to ? 1 : 0), 0);
  const periodStats = (days: number | null) => {
    if (days === null) {
      return {
        earningsCents: saleRows.reduce((s, r) => s + r.cents, 0), earningsTrend: null,
        prints: genRows.length, printsTrend: null,
        unlocks: saleRows.length, unlocksTrend: null,
      };
    }
    const from = now - days * DAY_MS, prevFrom = now - 2 * days * DAY_MS;
    const e = sumBetween(saleRows, from, now), eP = sumBetween(saleRows, prevFrom, from);
    const g = countBetween(genRows, from, now), gP = countBetween(genRows, prevFrom, from);
    const u = countBetween(saleRows, from, now), uP = countBetween(saleRows, prevFrom, from);
    return {
      earningsCents: e, earningsTrend: trend(e, eP),
      prints: g, printsTrend: trend(g, gP),
      unlocks: u, unlocksTrend: trend(u, uP),
    };
  };
  const stats = { week: periodStats(7), month: periodStats(30), all: periodStats(null) };

  // Conversion = unlocks / views (all-time); null until view tracking has data.
  const conversionPct = viewsAvailable && viewsTotal > 0
    ? Math.round((saleRows.length / viewsTotal) * 1000) / 10
    : null;

  // showcase_images is jsonb — tolerate arrays of strings or of {url} objects.
  const firstShowcase = (v: unknown): string | null => {
    if (!Array.isArray(v)) return null;
    for (const e of v) {
      if (typeof e === "string" && e) return e;
      if (e && typeof e === "object") {
        const u = (e as { url?: string; image_url?: string }).url ?? (e as { image_url?: string }).image_url;
        if (typeof u === "string" && u) return u;
      }
    }
    return null;
  };
  const imgById = new Map<string, string | null>(
    (myPrompts ?? []).map((p) => [String(p.id), firstShowcase((p as { showcase_images?: unknown }).showcase_images)]),
  );
  const topPrompts = [...(prompts ?? [])]
    .sort((a, b) => (b.earningsCents - a.earningsCents) || (b.generations - a.generations))
    .slice(0, 5)
    .filter((p) => p.earningsCents > 0 || p.generations > 0)
    .map((p) => {
      const v = viewCounts.get(p.id) ?? 0;
      return {
        id: p.id, title: p.title, image: imgById.get(p.id) ?? null,
        revenueCents: p.earningsCents, prints: p.generations,
        conversionPct: viewsAvailable && v > 0 ? Math.round((p.sales / v) * 1000) / 10 : null,
      };
    });

  // Activity: sales + prints + ratings merged, newest first.
  const activity = [
    ...saleRows.map((r) => ({ type: "sale" as const, prompt: titleById.get(r.promptId) ?? "Untitled", amountCents: r.cents, rating: null as number | null, at: r.at })),
    ...genRows.map((r) => ({ type: "print" as const, prompt: titleById.get(r.promptId) ?? "Untitled", amountCents: null as number | null, rating: null as number | null, at: r.at })),
    ...reviewRows.map((r) => ({ type: "rating" as const, prompt: titleById.get(r.promptId) ?? "Untitled", amountCents: null as number | null, rating: r.rating, at: r.at })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 8)
    .map((a) => ({ ...a, at: new Date(a.at).toISOString() }));

  return NextResponse.json({ summary, prompts, recentSales, charts, stats, conversionPct, topPrompts, activity });
}
