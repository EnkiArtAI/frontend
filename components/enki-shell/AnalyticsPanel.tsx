"use client";

/* Analytics — the "Enki Analytics" design on real data: period stat cards
   with trends, an earnings/prints line chart, top prompts with conversion,
   and a live activity feed (sales, renders, ratings). Everything comes from
   /api/analytics/me; missing tracking (views) shows as "—", never as fakes. */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { promptPage } from "@/lib/ui/image-view/open-link";

type Series = { labels: string[]; earningsCents: number[]; prints: number[] };
type PeriodStats = {
  earningsCents: number; earningsTrend: number | null;
  prints: number; printsTrend: number | null;
  unlocks: number; unlocksTrend: number | null;
};
type Payload = {
  charts?: { week: Series; month: Series; all: Series };
  stats?: { week: PeriodStats; month: PeriodStats; all: PeriodStats };
  conversionPct?: number | null;
  topPrompts?: { id: string; title: string; image: string | null; revenueCents: number; prints: number; conversionPct: number | null }[];
  activity?: { type: "sale" | "print" | "rating"; prompt: string; amountCents: number | null; rating: number | null; at: string }[];
};

type PeriodKey = "week" | "month" | "all";
const PERIODS: { label: string; key: PeriodKey }[] = [
  { label: "This week", key: "week" },
  { label: "This month", key: "month" },
  { label: "All time", key: "all" },
];

const MONO = "var(--font-mono), monospace";
const SERIF = "var(--font-serif), Georgia, serif";
const GREEN = "#1f8a5b", RED = "#b33a3a";
// pastel identity chips (same family as the editor's variable chips)
const PASTEL = {
  blue: { bg: "#E8F4FD", ink: "#1E4A6E" },
  green: { bg: "#E8F8EE", ink: "#1F5C38" },
  purple: { bg: "#F3E8FD", ink: "#4A2E6E" },
  gold: { bg: "#FDF6E8", ink: "#6E4A1E" },
};

const dollars = (cents: number) =>
  "$" + (cents / 100).toLocaleString("en-US", { maximumFractionDigits: cents % 100 === 0 ? 0 : 2 });
const timeAgo = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const card: React.CSSProperties = {
  border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 14,
  background: "var(--enki-paper)", padding: "14px 14px 8px",
};
const microLabel: React.CSSProperties = {
  fontFamily: MONO, fontSize: 8, letterSpacing: "0.13em", textTransform: "uppercase", color: "var(--enki-ink-3)",
};

function StatCard({ label, value, trendPct, icon, chip, noTrend }: {
  label: string; value: string; trendPct: number | null;
  icon: string; chip: { bg: string; ink: string }; noTrend?: boolean;
}) {
  const up = (trendPct ?? 0) >= 0;
  return (
    <div style={{ ...card, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ width: 22, height: 22, borderRadius: 7, background: chip.bg, color: chip.ink, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name={icon} size={12} stroke={2} />
        </span>
        <span style={microLabel}>{label}</span>
      </div>
      <span style={{ display: "block", fontFamily: SERIF, fontSize: 27, fontWeight: 700, lineHeight: 1, color: "var(--enki-ink)" }}>{value}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 3, marginTop: 6, fontFamily: MONO, fontSize: 9.5, fontWeight: 700, color: trendPct === null ? "var(--enki-ink-3)" : up ? GREEN : RED }}>
        {noTrend || trendPct === null ? "—" : `${up ? "↗" : "↘"} ${trendPct > 0 ? "+" : ""}${trendPct}%`}
        {!noTrend && trendPct !== null && <span style={{ fontWeight: 400, color: "var(--enki-ink-3)" }}> vs last period</span>}
      </span>
    </div>
  );
}

export default function AnalyticsPanel() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>("month");
  const [metric, setMetric] = useState<"earnings" | "prints">("earnings");

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/analytics/me", { headers: sessionAuthHeaders() });
        if (!res.ok) throw new Error();
        const d = (await res.json()) as Payload;
        if (!dead) setData(d);
      } catch {
        if (!dead) setFailed(true);
      }
    })();
    return () => { dead = true; };
  }, []);

  const ser = data?.charts?.[period];
  const st = data?.stats?.[period];
  const vals = ser ? (metric === "earnings" ? ser.earningsCents : ser.prints) : [];
  const hasAny = (data?.stats?.all?.prints ?? 0) > 0 || (data?.stats?.all?.unlocks ?? 0) > 0;

  // chart geometry (design: 720×200, baseline 160, top 14)
  const W = 720, top = 14, base = 160;
  const max = Math.max(...vals, 1) * 1.15;
  const pts = vals.map((v, i) => ({
    x: vals.length > 1 ? (i / (vals.length - 1)) * (W - 24) + 12 : W / 2,
    y: base - (v / max) * (base - top),
  }));
  const line = pts.map((p, i) => (i ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");
  const area = pts.length ? `${line} L ${pts[pts.length - 1].x.toFixed(1)} ${base} L ${pts[0].x.toFixed(1)} ${base} Z` : "";

  return (
    <div style={{ maxWidth: 1060, margin: "0 auto", padding: "26px 28px 40px" }}>
      {/* ── header ── */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap", marginBottom: 18 }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 34, fontWeight: 400, margin: "0 0 3px", lineHeight: 1, color: "var(--enki-ink)" }}>Analytics.</h1>
          <p style={{ margin: 0, fontSize: 12, color: "var(--enki-ink-3)" }}>How your prompts earn, print, and convert.</p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {PERIODS.map((p) => (
            <button key={p.key} onClick={() => setPeriod(p.key)} style={{
              padding: "5px 11px", borderRadius: 999, fontSize: 10.5, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer",
              border: "1px solid " + (period === p.key ? "var(--enki-ink)" : "var(--enki-rule)"),
              background: period === p.key ? "var(--enki-ink)" : "var(--enki-paper)",
              color: period === p.key ? "var(--enki-paper)" : "var(--enki-ink)",
              transition: "all 0.15s",
            }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {failed ? (
        <div style={{ padding: "60px 0", textAlign: "center", color: "var(--enki-ink-3)", fontSize: 13 }}>Could not load your analytics — try again in a moment.</div>
      ) : !data ? (
        <div style={{ padding: "60px 0", textAlign: "center", color: "var(--enki-ink-3)", fontSize: 13 }}>Loading…</div>
      ) : !hasAny ? (
        <div style={{ padding: "72px 0", textAlign: "center", maxWidth: 460, margin: "0 auto" }}>
          <div style={{ fontFamily: SERIF, fontSize: 24, fontStyle: "italic", color: "var(--enki-ink-2)" }}>Nothing to chart yet.</div>
          <p style={{ fontSize: 14, color: "var(--enki-ink-3)", marginTop: 8 }}>
            Release a prompt and this page fills up with earnings, renders and ratings.
          </p>
        </div>
      ) : (
        <>
          {/* ── stat cards ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginBottom: 12 }}>
            <StatCard label="Earnings" value={dollars(st?.earningsCents ?? 0)} trendPct={st?.earningsTrend ?? null}
              icon="dollar" chip={{ bg: "rgba(var(--ember-rgb), 0.12)", ink: "var(--enki-ember)" }} />
            <StatCard label="Prints" value={(st?.prints ?? 0).toLocaleString("en-US")} trendPct={st?.printsTrend ?? null}
              icon="sparkles" chip={PASTEL.blue} />
            <StatCard label="Unlocks" value={(st?.unlocks ?? 0).toLocaleString("en-US")} trendPct={st?.unlocksTrend ?? null}
              icon="unlock" chip={PASTEL.green} />
            <StatCard label="Conversion" value={data.conversionPct === null || data.conversionPct === undefined ? "—" : `${data.conversionPct}%`}
              trendPct={null} noTrend icon="target" chip={PASTEL.purple} />
          </div>

          {/* ── chart ── */}
          <div style={{ ...card, padding: "14px 16px 8px", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontFamily: SERIF, fontSize: 17, fontWeight: 700, color: "var(--enki-ink)" }}>
                {metric === "earnings" ? "Earnings over time" : "Prints over time"}
              </span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                {(["earnings", "prints"] as const).map((m) => (
                  <button key={m} onClick={() => setMetric(m)} style={{
                    padding: "4px 10px", borderRadius: 999, fontSize: 10, fontWeight: 600, cursor: "pointer",
                    border: "1px solid " + (metric === m ? "rgba(var(--ember-rgb), 0.45)" : "var(--enki-rule)"),
                    background: metric === m ? "rgba(var(--ember-rgb), 0.12)" : "var(--enki-paper)",
                    color: metric === m ? "var(--enki-ember)" : "var(--enki-ink-3)",
                  }}>
                    {m === "earnings" ? "Earnings" : "Prints"}
                  </button>
                ))}
              </div>
            </div>
            <svg viewBox="0 0 720 200" style={{ width: "100%", height: "auto", display: "block" }} preserveAspectRatio="none">
              <line x1={0} y1={160} x2={720} y2={160} stroke="var(--enki-rule-2, var(--enki-rule))" strokeWidth={1} />
              <line x1={0} y1={110} x2={720} y2={110} stroke="var(--enki-rule-2, var(--enki-rule))" strokeWidth={1} strokeDasharray="4 4" />
              <line x1={0} y1={60} x2={720} y2={60} stroke="var(--enki-rule-2, var(--enki-rule))" strokeWidth={1} strokeDasharray="4 4" />
              {area && <path d={area} fill="rgba(var(--ember-rgb), 0.12)" />}
              {line && <path d={line} fill="none" stroke="var(--enki-ember)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />}
              {pts.map((p, i) => (
                <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={3.2} fill="var(--enki-paper)" stroke="var(--enki-ember)" strokeWidth={2} />
              ))}
            </svg>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 2px 6px" }}>
              {(ser?.labels ?? []).map((t, i) => (
                <span key={i} style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--enki-ink-3)" }}>{t}</span>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1.35fr 1fr", gap: 12, alignItems: "start" }}>
            {/* ── top prompts ── */}
            <div style={card}>
              <span style={{ display: "block", fontFamily: SERIF, fontSize: 17, fontWeight: 700, marginBottom: 10, color: "var(--enki-ink)" }}>Top prompts</span>
              {(data.topPrompts ?? []).length === 0 && (
                <div style={{ padding: "14px 4px", fontSize: 12, color: "var(--enki-ink-3)" }}>No prompt activity yet.</div>
              )}
              {(data.topPrompts ?? []).map((r, i) => (
                <button key={r.id} onClick={() => router.push(promptPage(r.id))} title={`Open “${r.title}”`} style={{
                  display: "flex", alignItems: "center", gap: 11, padding: "8px 4px", width: "100%",
                  border: "none", borderTop: "1px dashed var(--enki-rule-2, var(--enki-rule))",
                  background: "none", textAlign: "left", cursor: "pointer",
                }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: i === 0 ? "var(--enki-ember)" : "var(--enki-ink-3)", width: 16, flexShrink: 0, textAlign: "center" }}>{i + 1}</span>
                  <span style={{ width: 58, height: 40, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: "var(--enki-paper-3)" }}>
                    {r.image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image} alt="" loading="lazy" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
                    )}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</span>
                    {r.conversionPct !== null && (
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ flex: 1, maxWidth: 150, height: 4, borderRadius: 2, background: "var(--enki-paper-3)", overflow: "hidden" }}>
                          <span style={{ display: "block", height: "100%", width: `${Math.min(100, r.conversionPct)}%`, background: "var(--enki-ember)", borderRadius: 2 }} />
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)", whiteSpace: "nowrap" }}>{r.conversionPct}% conversion</span>
                      </span>
                    )}
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, flexShrink: 0 }}>
                    <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: "var(--enki-ember)" }}>{dollars(r.revenueCents)}</span>
                    <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{r.prints.toLocaleString("en-US")} prints</span>
                  </span>
                </button>
              ))}
            </div>

            {/* ── recent activity ── */}
            <div style={card}>
              <span style={{ display: "block", fontFamily: SERIF, fontSize: 17, fontWeight: 700, marginBottom: 10, color: "var(--enki-ink)" }}>Recent activity</span>
              {(data.activity ?? []).length === 0 && (
                <div style={{ padding: "14px 4px", fontSize: 12, color: "var(--enki-ink-3)" }}>Quiet so far — sales, renders and ratings land here.</div>
              )}
              {(data.activity ?? []).map((a, i) => {
                const chip = a.type === "sale" ? PASTEL.green : a.type === "print" ? PASTEL.blue : PASTEL.gold;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 2px", borderTop: "1px dashed var(--enki-rule-2, var(--enki-rule))" }}>
                    <span style={{ width: 24, height: 24, borderRadius: "50%", background: chip.bg, color: chip.ink, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Icon name={a.type === "sale" ? "unlock" : a.type === "print" ? "sparkles" : "star"} size={11} stroke={2} fill={a.type === "rating" ? "currentColor" : "none"} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {a.type === "sale" ? "Prompt unlocked" : a.type === "print" ? "Image generated" : `New ${a.rating ?? "?"}★ rating`}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--enki-ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.prompt}</span>
                    </span>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
                      <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: a.type === "rating" ? PASTEL.gold.ink : GREEN }}>
                        {a.type === "sale" && a.amountCents !== null ? `+${dollars(a.amountCents)}` : a.type === "rating" && a.rating !== null ? a.rating.toFixed(1) : ""}
                      </span>
                      <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--enki-ink-3)" }}>{timeAgo(a.at)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
