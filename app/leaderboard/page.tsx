"use client";

/* Hall of Fame — the "Enki Leaderboard" design on real data: editorial top-3
   cards (best-prompt image, sparkline, delta), a dense table for ranks 4+,
   Generations/Earnings tabs and period pills. No mock content: sparklines and
   deltas come from real 14-day buckets, images from the prompt's showcase. */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { sessionAuthHeaders } from "@/lib/session-headers";

type Metric = "generations" | "earnings";
type Row = {
  rank: number;
  handle: string;
  value: number;
  unit: "gen" | "usd";
  bestPromptId: string | null;
  bestPromptTitle: string | null;
  image: string | null;
  spark: number[] | null;
  delta: number | null;
  sub: number | null; // earnings: distinct prompts sold
};

const PERIODS: { label: string; key: string }[] = [
  { label: "This week", key: "week" },
  { label: "This month", key: "month" },
  { label: "All time", key: "all" },
];

const GREEN = "#1f8a5b", RED = "#e0584f";
const SPARK_UP = "#9AD4B0", SPARK_DOWN = "#E8A0A0";
const MONO = "var(--font-mono), monospace";
const SERIF = "var(--font-serif), Georgia, serif";

const initials = (h: string) => h.replace(/^@/, "").slice(0, 2).toUpperCase();
const fmtVal = (r: Row) =>
  r.unit === "usd" ? `$${r.value.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : r.value.toLocaleString("en-US");
const fmtDelta = (r: Row) => {
  if (r.delta === null) return "—";
  const n = r.unit === "usd" ? Math.round(Math.abs(r.delta) / 100) : Math.abs(r.delta);
  const v = r.unit === "usd" ? `$${n.toLocaleString("en-US")}` : n.toLocaleString("en-US");
  return r.delta > 0 ? `↑ +${v}` : r.delta < 0 ? `↓ ${v}` : "—";
};
const deltaInk = (r: Row) => (r.delta === null || r.delta === 0 ? "var(--enki-ink-3)" : r.delta > 0 ? GREEN : RED);

/** Real series → polyline points; flat baseline when everything is zero. */
const sparkPoints = (vals: number[] | null, w: number, h: number) => {
  if (!vals || vals.length < 2) return null;
  const max = Math.max(...vals, 1);
  return vals
    .map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${((1 - v / max) * (h - 3) + 1.5).toFixed(1)}`)
    .join(" ");
};

const mono = (size: number, color?: string, extra?: React.CSSProperties): React.CSSProperties => ({
  fontFamily: MONO, fontSize: size, ...(color ? { color } : null), ...extra,
});
const headCell = (extra?: React.CSSProperties): React.CSSProperties =>
  mono(8.5, "var(--enki-ink-3)", { letterSpacing: "0.12em", textTransform: "uppercase", ...extra });

export default function LeaderboardPage() {
  const router = useRouter();
  const [metric, setMetric] = useState<Metric>("generations");
  const [period, setPeriod] = useState("week");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [me, setMe] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    setRows(null);
    (async () => {
      try {
        const res = await fetch(`/api/leaderboard?metric=${metric}&period=${period}`, { headers: sessionAuthHeaders() });
        const data = res.ok ? await res.json() : { rows: [] };
        if (!dead) setRows(data.rows ?? []);
      } catch {
        if (!dead) setRows([]);
      }
    })();
    return () => { dead = true; };
  }, [metric, period]);

  // Own handle → the "you" chip. Signed-out visitors simply get no chip.
  useEffect(() => {
    const headers = sessionAuthHeaders();
    if (Object.keys(headers).length === 0) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/users/handle", { headers });
        if (!res.ok) return;
        const d = (await res.json()) as { handle?: string | null };
        if (!dead && d.handle) setMe(d.handle);
      } catch { /* no chip */ }
    })();
    return () => { dead = true; };
  }, []);

  const openPrompt = (id: string | null) => { if (id) router.push(`/generator/${id}`); };

  const isGens = metric === "generations";
  const periodLabel = (PERIODS.find((p) => p.key === period)?.label ?? "This week").toLowerCase();
  const podium = rows && rows.length >= 3 ? rows.slice(0, 3) : [];
  const listRows = rows ? (podium.length ? rows.slice(3) : rows) : [];

  return (
    <div className="ek-leaderboard-container" style={{ maxWidth: 880, margin: "0 auto" }}>
      {/* ── header: title + tabs + periods (no eyebrow) ── */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 22 }}>
        <div>
          <h1 style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 44, fontWeight: 400, margin: "0 0 4px", lineHeight: 1.05, color: "var(--enki-ink)" }}>
            Hall of Fame.
          </h1>
          <p style={{ fontSize: 13.5, color: "var(--enki-ink-3)", margin: 0 }}>
            {isGens ? `Who got rendered the most ${periodLabel}.` : `Who earned the most from their prompts ${periodLabel}.`}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <div style={{ display: "inline-flex", background: "color-mix(in oklab, var(--enki-ink) 7%, transparent)", borderRadius: 8, padding: 2 }}>
            {(["generations", "earnings"] as Metric[]).map((t) => (
              <button key={t} onClick={() => setMetric(t)} style={{
                height: 26, padding: "0 14px", border: "none", borderRadius: 6, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
                background: metric === t ? "var(--enki-ember)" : "transparent",
                color: metric === t ? "#fff" : "var(--enki-ink-2)",
                transition: "all 0.15s",
              }}>
                {t === "generations" ? "Generations" : "Earnings"}
              </button>
            ))}
          </div>
          <div style={{ display: "inline-flex", gap: 4 }}>
            {PERIODS.map((p) => (
              <button key={p.key} onClick={() => setPeriod(p.key)} style={{
                padding: "4px 10px", borderRadius: 999, fontSize: 10.5, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer",
                border: "1px solid " + (period === p.key ? "var(--enki-ink)" : "var(--enki-rule)"),
                background: period === p.key ? "var(--enki-ink)" : "transparent",
                color: period === p.key ? "var(--enki-paper)" : "var(--enki-ink-3)",
                transition: "all 0.15s",
              }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {rows === null ? (
        <div style={{ padding: "60px 0", textAlign: "center", color: "var(--enki-ink-3)", fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: "72px 0", textAlign: "center", maxWidth: 460, margin: "0 auto" }}>
          <div style={{ fontFamily: SERIF, fontSize: 24, fontStyle: "italic", color: "var(--enki-ink-2)" }}>No rankings yet.</div>
          <p style={{ fontSize: 14, color: "var(--enki-ink-3)", marginTop: 8 }}>
            Be the first to climb the board — publish a prompt and let people generate with it.
          </p>
        </div>
      ) : (
        <>
          {/* ── top 3: editorial cards (#1 centered + lifted) ── */}
          {podium.length === 3 && (
            <div className="ek-podium-grid">
              {podium.map((r, i) => {
                const first = i === 0;
                return (
                  <div key={r.rank} className={"ek-podium-card" + (first ? " ek-podium-card--first" : "")} style={{
                    order: [2, 1, 3][i],
                    position: "relative", display: "flex", flexDirection: "column", gap: 8,
                    background: "var(--enki-paper)",
                    border: first ? "1.5px solid var(--enki-ember)" : "1px solid var(--enki-rule)",
                    borderRadius: 14, padding: "14px 14px 12px",
                    boxShadow: first ? "0 12px 30px rgba(var(--ember-rgb), 0.16)" : "0 1px 3px rgba(0,0,0,0.06)",
                    marginTop: first ? 0 : 10,
                  }}>
                    <span style={{
                      position: "absolute", top: -12, left: 12, fontFamily: SERIF, fontStyle: "italic", fontWeight: 700,
                      fontSize: 34, lineHeight: 1, color: first ? "var(--enki-ember)" : "var(--enki-ink-3)",
                      textShadow: "0 1px 0 var(--enki-paper), 0 2px 8px rgba(0,0,0,0.12)",
                    }}>
                      No.{r.rank}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 10 }}>
                      <span style={{
                        width: first ? 42 : 34, height: first ? 42 : 34, borderRadius: "50%", flexShrink: 0,
                        background: first ? "var(--cta-bg)" : "var(--enki-paper-3)",
                        color: first ? "var(--cta-ink)" : "var(--enki-ink-2)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontFamily: MONO, fontSize: 12, fontWeight: 700,
                        boxShadow: first ? "0 4px 14px rgba(0,0,0,0.3)" : "none",
                      }}>
                        {initials(r.handle)}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          @{r.handle}
                        </span>
                        <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                          <span style={mono(16, "var(--enki-ink)", { fontWeight: 700 })}>{fmtVal(r)}</span>
                          <span style={mono(10, deltaInk(r))}>{fmtDelta(r)}</span>
                        </span>
                      </span>
                    </div>
                    {r.spark && (
                      <svg viewBox="0 0 120 26" preserveAspectRatio="none" style={{ width: "100%", height: 26, display: "block" }}>
                        <polyline points={sparkPoints(r.spark, 120, 26) ?? ""} fill="none"
                          stroke={first ? "var(--enki-ember)" : "var(--enki-ink-3)"} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    <div style={{ borderTop: "1px dashed var(--enki-rule-2, var(--enki-rule))", paddingTop: 8 }}>
                      <span style={headCell({ display: "block", fontSize: 7.5, marginBottom: 5 })}>Best prompt</span>
                      {r.bestPromptTitle ? (
                        <button onClick={() => openPrompt(r.bestPromptId)} title={`Open “${r.bestPromptTitle}”`}
                          style={{ display: "block", width: "100%", border: "none", background: "none", padding: 0, textAlign: "left", cursor: "pointer" }}>
                          <span style={{ display: "block", width: "100%", aspectRatio: "16/9", border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 10, overflow: "hidden", background: "var(--enki-paper-3)" }}>
                            {r.image && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={r.image} alt={r.bestPromptTitle} loading="lazy"
                                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                            )}
                          </span>
                          <span style={{ display: "block", marginTop: 6, fontFamily: SERIF, fontSize: 13.5, lineHeight: 1.3, color: "var(--enki-ink)" }}>
                            {r.bestPromptTitle}
                          </span>
                        </button>
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--enki-ink-3)", fontStyle: "italic" }}>—</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── ranks 4+ (or everyone when there's no full podium) ── */}
          {listRows.length > 0 && (
            <div className="ek-leaderboard-table-wrap" style={{ background: "var(--enki-paper)", border: "1px solid var(--enki-rule)", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
              <div className="ek-leaderboard-table-inner">
              <div style={{ display: "grid", gridTemplateColumns: "44px 1fr 110px 84px 90px 70px", gap: 8, alignItems: "center", padding: "8px 14px", borderBottom: "1px solid var(--enki-rule-2, var(--enki-rule))" }}>
                <span style={headCell()}>Rank</span>
                <span style={headCell()}>Creator</span>
                <span style={headCell({ textAlign: "right" })}>{isGens ? "Renders" : "Earned"}</span>
                <span style={headCell({ textAlign: "right" })}>{isGens ? "" : "Prompts"}</span>
                <span style={headCell()}>Trend</span>
                <span />
              </div>
              {listRows.map((r) => {
                const you = me !== null && r.handle === me;
                return (
                  <div key={r.rank} style={{
                    display: "grid", gridTemplateColumns: "44px 1fr 110px 84px 90px 70px", gap: 8, alignItems: "center",
                    padding: "7px 14px", borderBottom: "1px solid var(--enki-rule-2, var(--enki-rule))",
                    background: you ? "rgba(var(--ember-rgb), 0.07)" : "transparent",
                  }}>
                    <span style={mono(12, "var(--enki-ink-3)", { fontWeight: 700 })}>#{r.rank}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{
                        width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                        background: you ? "var(--cta-bg)" : "var(--enki-paper-3)",
                        color: you ? "var(--cta-ink)" : "var(--enki-ink-2)",
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        fontFamily: MONO, fontSize: 9, fontWeight: 700,
                      }}>
                        {initials(r.handle)}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        @{r.handle}
                      </span>
                      {you && (
                        <span style={mono(9, "var(--enki-ink-3)", { background: "color-mix(in oklab, var(--enki-ink) 5%, transparent)", borderRadius: 4, padding: "1px 5px", flexShrink: 0 })}>
                          you
                        </span>
                      )}
                    </span>
                    <span style={mono(12.5, "var(--enki-ink)", { fontWeight: 700, textAlign: "right" })}>{fmtVal(r)}</span>
                    <span style={mono(10.5, "var(--enki-ink-3)", { textAlign: "right" })}>
                      {isGens ? "" : `${r.sub ?? 0} prompt${(r.sub ?? 0) === 1 ? "" : "s"}`}
                    </span>
                    {r.spark ? (
                      <svg viewBox="0 0 90 20" preserveAspectRatio="none" style={{ width: 90, height: 20, display: "block" }}>
                        <polyline points={sparkPoints(r.spark, 90, 20) ?? ""} fill="none"
                          stroke={(r.delta ?? 0) >= 0 ? SPARK_UP : SPARK_DOWN} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : <span />}
                    <span style={mono(10.5, deltaInk(r), { textAlign: "right" })}>{fmtDelta(r)}</span>
                  </div>
                );
              })}
              <div className="ek-leaderboard-footer" style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", background: "var(--enki-paper-2)", flexWrap: "wrap" }}>
                <span style={headCell({ fontSize: 9 })}>Visibility</span>
                <span style={{ fontSize: 11, color: "var(--enki-ink-3)" }}>You can hide yourself from this list in Settings → Profile.</span>
                <button onClick={() => router.push("/editor")} style={{ marginLeft: "auto", border: "none", background: "none", padding: 0, cursor: "pointer", fontSize: 11, fontWeight: 600, color: "var(--enki-ember)" }}>
                  Climb the board — create a prompt →
                </button>
              </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
