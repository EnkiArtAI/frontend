/**
 * Hall of Fame — public leaderboard.
 *
 *   GET ?metric=generations|earnings&period=week|month|all
 *     → { rows: [{ rank, handle, value, unit, bestPromptId, bestPromptTitle,
 *                  image, spark, delta, sub }] }
 *
 * DB-side aggregation via the leaderboard_* RPCs (2026-07-14-hall-of-fame.sql);
 * trend sparklines/deltas via leaderboard_*_series (2026-07-20-leaderboard-trend.sql):
 * real 14-day daily buckets, delta = last 7 days vs the 7 before. Podium images
 * come from prompts.showcase_images with a generated_images fallback (verified
 * live 2026-07-20). Every extra is best-effort — rows always render.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isListed } from "@/lib/prompt-visibility";
import { hiddenOwners } from "@/lib/hidden-owners";

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 14;

type GenRow = { creator_id: string; handle: string | null; total: number; best_prompt_id: string | null; best_prompt_title: string | null };
type EarnRow = { creator_id: string; handle: string | null; total_cents: number; best_prompt_id: string | null; best_prompt_title: string | null };
type SeriesRow = { creator_id: string; day: string; n?: number; cents?: number };

/** Last N UTC days as YYYY-MM-DD, oldest first. */
const dayKeys = () => {
  const out: string[] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) out.push(new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10));
  return out;
};

/** showcase_images is jsonb — tolerate arrays of strings or of {url} objects. */
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

export async function GET(req: NextRequest) {
  const metric = req.nextUrl.searchParams.get("metric") === "earnings" ? "earnings" : "generations";
  const period = req.nextUrl.searchParams.get("period") ?? "week";
  const since =
    period === "all" ? null
    : new Date(Date.now() - (period === "month" ? 30 : 7) * DAY_MS).toISOString();

  const supabase = getSupabaseServerClient();
  const isEarn = metric === "earnings";

  const { data, error } = await supabase.rpc(
    isEarn ? "leaderboard_earnings" : "leaderboard_generations",
    { p_since: since, p_limit: 20 },
  );
  if (error) return NextResponse.json({ rows: [] }); // pre-migration → empty

  // A banned or deleted account leaves the board; a lookup that fails shows none.
  const all = (data ?? []) as (GenRow & EarnRow)[];
  const offBoard = await hiddenOwners(supabase, all.map((r) => String(r.creator_id))).catch(() => null);
  if (!offBoard) return NextResponse.json({ rows: [] });
  const raw = all.filter((r) => !offBoard.has(String(r.creator_id)));
  const ids = raw.map((r) => r.creator_id);

  // ── best-effort extras, fetched in parallel ──
  const since14 = new Date(Date.now() - TREND_DAYS * DAY_MS).toISOString();
  const podiumIds = raw.slice(0, 3).map((r) => r.best_prompt_id).filter(Boolean) as string[];
  const bestIds = [...new Set(raw.map((r) => r.best_prompt_id).filter(Boolean))] as string[];
  const [seriesRes, showcaseRes, genImgRes, purchRes] = await Promise.all([
    ids.length
      ? supabase.rpc(isEarn ? "leaderboard_earn_series" : "leaderboard_gen_series", { p_creators: ids, p_since: since14 })
      : Promise.resolve({ data: [], error: null }),
    bestIds.length
      ? supabase.from("prompts").select("id, showcase_images, is_adult, is_listed, listing_status, deleted_at").in("id", bestIds)
      : Promise.resolve({ data: [], error: null }),
    podiumIds.length
      ? supabase.from("generated_images").select("prompt_id, user_id, thumbnail_url, storage_url, created_at")
          .in("prompt_id", podiumIds).is("deleted_at", null).eq("is_adult", false).eq("visibility", "public")
          .order("created_at", { ascending: false }).limit(30)
      : Promise.resolve({ data: [], error: null }),
    isEarn && ids.length
      ? (() => {
          let q = supabase.from("prompt_purchases").select("seller_id, prompt_id")
            .eq("status", "completed").in("seller_id", ids).limit(10000);
          if (since) q = q.gte("completed_at", since);
          return q;
        })()
      : Promise.resolve({ data: [], error: null }),
  ]);

  // 14-day buckets per creator → spark + delta (last 7 vs the 7 before)
  const days = dayKeys();
  const spark = new Map<string, number[]>();
  if (!seriesRes.error) {
    for (const r of (seriesRes.data ?? []) as SeriesRow[]) {
      const di = days.indexOf(String(r.day).slice(0, 10));
      if (di < 0) continue;
      const arr = spark.get(r.creator_id) ?? new Array(TREND_DAYS).fill(0);
      arr[di] += Number(r.n ?? r.cents ?? 0);
      spark.set(r.creator_id, arr);
    }
  }
  const trendReady = !seriesRes.error;

  // The Hall of Fame is public: a creator whose best prompt is 18+ or was
  // never released keeps the rank, but the prompt shows no title, link or
  // image, not even one of its renders, on any row. An unreleased prompt is
  // a draft, or the row a free-form generation creates, titled with the
  // first words the user typed.
  const images = new Map<string, string>();
  const hidden = new Set<string>();
  // Unable to tell which prompts are 18+ or unreleased: show none of them.
  if (showcaseRes.error) bestIds.forEach((id) => hidden.add(id));
  for (const p of (showcaseRes.data ?? []) as { id: string; showcase_images: unknown; is_adult: boolean | null; is_listed: boolean | null; listing_status: string | null; deleted_at: string | null }[]) {
    if (p.is_adult || !isListed(p)) { hidden.add(p.id); continue; }
    const u = firstShowcase(p.showcase_images);
    if (u && podiumIds.includes(p.id)) images.set(p.id, u);
  }
  // Not an image of a banned or deleted account; none when that cannot be read.
  const renders = (genImgRes.data ?? []) as { prompt_id: string; user_id: string; thumbnail_url: string | null; storage_url: string | null }[];
  const renderOwners = await hiddenOwners(supabase, renders.map((g) => String(g.user_id ?? ""))).catch(() => null);
  for (const g of renderOwners ? renders.filter((g) => !renderOwners.has(String(g.user_id))) : []) {
    const u = g.thumbnail_url || g.storage_url;
    if (u && !images.has(g.prompt_id)) images.set(g.prompt_id, u);
  }

  const promptCounts = new Map<string, Set<string>>();
  for (const p of (purchRes.data ?? []) as { seller_id: string; prompt_id: string | null }[]) {
    if (!p.prompt_id) continue;
    (promptCounts.get(p.seller_id) ?? promptCounts.set(p.seller_id, new Set()).get(p.seller_id)!).add(p.prompt_id);
  }

  const rows = raw.map((r, i) => {
    const show = !(r.best_prompt_id && hidden.has(r.best_prompt_id));
    const s = spark.get(r.creator_id) ?? (trendReady ? new Array(TREND_DAYS).fill(0) : null);
    const delta = s ? s.slice(7).reduce((a, b) => a + b, 0) - s.slice(0, 7).reduce((a, b) => a + b, 0) : null;
    return {
      rank: i + 1,
      handle: r.handle ?? "unnamed",
      value: isEarn ? (r.total_cents ?? 0) / 100 : (r.total ?? 0),
      unit: isEarn ? ("usd" as const) : ("gen" as const),
      bestPromptId: show ? r.best_prompt_id : null,
      bestPromptTitle: show ? r.best_prompt_title : null,
      image: (show && r.best_prompt_id && images.get(r.best_prompt_id)) || null,
      spark: s,
      delta,
      sub: isEarn ? (promptCounts.get(r.creator_id)?.size ?? 0) : null,
    };
  });

  return NextResponse.json({ rows });
}
