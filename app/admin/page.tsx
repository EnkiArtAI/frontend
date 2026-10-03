"use client";

/* Admin panel — the "Enki Admin" design on REAL moderation data.
   Gate: BetaGate role (admin/mod) client-side for the UI states; every API
   call re-checks the role server-side (app/api/admin — the actual wall).
   The content area follows the app theme (--enki-* vars); the sidebar is the
   deliberately inverted warm-dark "admin mode" identity in every theme. */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/enki-shell/icons";
/* The page below is styled with `.ek-app` + --enki-* — but this route never
   pulled in the stylesheet that defines them (only /home imports it, via
   EnkiHome). The tokens then fell back to the stale globals.css copy, which
   has no `.dark.theme-purple` block at all: the panel stayed neutral black
   with an orange accent while the rest of the app went violet. */
import "@/components/enki-shell/enki-shell.css";
import { useBetaAccess } from "@/components/BetaGate";
import { useTheme } from "../../providers/ThemeProvider";
import { sessionAuthHeaders } from "@/lib/session-headers";

/* ── data shapes (from /api/admin) ── */
type Imp = { id: string; name: string; url: string | null; hunter: string; tags: string[]; at: string };
type Rep = { id: string; target: string; type: "prompt" | "profile"; reason: string; details: string | null; reporter: string; severity: number | string | null; at: string };
type Fb = { id: string; name: string; email: string | null; desc: string; images: number; paid: boolean; payoutCents: number | null; at: string };
type Friend = { id: string; name: string; address: string; type: string; chain: string; notes: string | null };
type Hunter = { handle: string; total: number; approved: number; denied: number; earningsCents: number };
type StrikeRow = { userId: string; handle: string; strikes: { id: string; reason: string | null }[]; banned: boolean; permanent: boolean; note: string | null; appeal: { id: string; note: string | null } | null };
type Rec = { id: string; handle: string; wallet: string | null; contact: string | null; explanation: string | null; evidence: { kind: string; matched: boolean | null }[]; status: string; at: string };
type Proposal = { id: string; kind: string; target: string; targetUserId: string | null; days: number | null; violation: string; proposer: string; status: string; confirms: number; denies: number; myVote: string | null; quorum: number; at: string; expiresAt: string };
type Council = { ready: boolean; isOwner: boolean; enabled: boolean; quorum: number; ttlDays: number; members: { handle: string; role: string; hasEmail: boolean }[]; myEmail: string | null; proposals: Proposal[] };
type Automod = { id: string; handle: string | null; surface: string; severity: string; tier: number | null; category: string | null; rules: string[]; topScore: { name: string; value: number } | null; prompt: string | null; state: string; at: string };
type GenPolicy = { maxConcurrentPerUser: number | null; canEdit: boolean };
type Person = { key: string; userId: string | null; ipHash: string | null; handle: string | null; displayName: string | null; warnings: number; extractionHits: number; childSafety: boolean; pending: number; suspension: { until: string | null } | null; failed7d: number; lastActive: string | null };
type PersonDetail = {
  events: { id: string; category: string | null; severity: string; surface: string; rules: string[]; weight: number; confidence: number | null; prompt: string | null; state: string; at: string }[];
  failures: { id: string; surface: string; model: string | null; resolution: string | null; quality: string | null; boost: boolean; aspectRatio: string | null; referenceImageCount: number; error: string; prompt: string | null; imageUrl: string | null; txSignature: string | null; at: string }[];
  bans: { id: string; reason: string | null; expiresAt: string | null; liftedAt: string | null; at: string }[];
};
type AdminData = { generation: GenPolicy; imports: Imp[]; reports: Rep[]; feedback: Fb[]; friends: Friend[]; hunters: Hunter[]; strikes: StrikeRow[]; recovery: Rec[]; council: Council; automod: Automod[]; people: Person[] };
const COUNCIL_OFF: Council = { ready: false, isOwner: false, enabled: false, quorum: 3, ttlDays: 7, members: [], myEmail: null, proposals: [] };

type Tab = "people" | "imports" | "reports" | "feedback" | "friends" | "hunters" | "strikes" | "automod" | "council" | "recovery" | "settings";
const REJECT_REASONS = ["Duplicate", "Low quality", "Not a prompt", "Spam", "Policy violation", "Other"];

/* ── the admin sidebar's own palette: inverted warm dark, theme-independent ── */
const SB = {
  bg: "#1a1715", ink: "#f0ece3", muted: "#8a8377", nav: "#b9b2a4", navOn: "#faf8f4",
  ember: "#c96838", emberText: "#f0b799", emberHover: "#ffd9c2",
};
const MONO = "var(--font-mono), monospace";
const SERIF = "var(--font-serif), Georgia, serif";
/* status pill palettes (literal pastels, same family as the rest of the app) */
const PILL = {
  green: { bg: "#E8F8EE", ink: "#1F5C38", border: "#9AD4B0" },
  red: { bg: "#FDE8E8", ink: "#8B2E2E", border: "#E8A0A0" },
  amber: { bg: "#FDF6E8", ink: "#6E4A1E", border: "#E8C89A" },
  purple: { bg: "#F3E8FD", ink: "#4A2E6E", border: "#C4A0E8" },
  blue: { bg: "#E8F4FD", ink: "#1E4A6E", border: "#9CCAE8" },
};
const THEME_OPTS = [
  { id: "light" as const, name: "Bright", sw: "linear-gradient(135deg,#faf8f4,#e8e2d6)" },
  { id: "dark" as const, name: "Dark", sw: "linear-gradient(135deg,#0a1825,#16303f)" },
  { id: "purple" as const, name: "Purple", sw: "linear-gradient(135deg,#1a1228,#6d28d9)" },
];

const timeAgo = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const dollars = (cents: number) => "$" + Math.round(cents / 100).toLocaleString("en-US");

const microLabel: React.CSSProperties = { fontFamily: MONO, fontSize: 7.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--enki-ink-3)" };
const cardStyle: React.CSSProperties = { border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 13, background: "var(--enki-paper)", padding: "4px 14px 6px" };
const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px dashed var(--enki-rule-2, var(--enki-rule))" };

function Pill({ kind, label, onClick, title }: { kind: keyof typeof PILL | "plain"; label: string; onClick?: () => void; title?: string }) {
  const c = kind === "plain"
    ? { bg: "var(--enki-paper-2)", ink: "var(--enki-ink-2)", border: "var(--enki-rule-2)" }
    : PILL[kind];
  return (
    <button onClick={onClick} title={title} style={{
      padding: "4px 11px", borderRadius: 999, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap",
      background: c.bg, color: c.ink, border: `1px solid ${c.border}`, cursor: onClick ? "pointer" : "default",
    }}>
      {label}
    </button>
  );
}
function Badge({ pal, label }: { pal: { bg: string; ink: string }; label: string }) {
  return (
    <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", borderRadius: 4, padding: "2px 7px", background: pal.bg, color: pal.ink, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

const TABS: { id: Tab; label: string; icon: string; sub: string; search: boolean }[] = [
  { id: "people", label: "People", icon: "user", sub: "Everyone who was warned, blocked, suspended or whose generations failed this week. Click a row for every event with its prompt and settings.", search: true },
  { id: "imports", label: "Pending imports", icon: "inbox", sub: "Hunt submissions waiting for review before they hit the marketplace.", search: true },
  { id: "reports", label: "Reports", icon: "flag", sub: "User-flagged prompts and profiles, grouped by target.", search: false },
  { id: "feedback", label: "Feedback", icon: "message", sub: "Submissions from the “Earn $100 for feedback” program. Click a row to read it all.", search: true },
  { id: "friends", label: "Friends (whitelist)", icon: "key", sub: "Wallets and collections with early or elevated access.", search: false },
  { id: "hunters", label: "Hunter trust", icon: "target", sub: "Importers ranked by how often their finds get approved.", search: false },
  { id: "strikes", label: "Strikes & bans", icon: "zap", sub: "Users with active strikes, bans, and open appeals.", search: false },
  { id: "automod", label: "Auto-filter log", icon: "filetext", sub: "Every prompt the filter blocked, with the reason and the score. Review and overturn them per person in People.", search: true },
  { id: "council", label: "Council", icon: "hand", sub: "Ban decisions the admin council votes on — quorum executes automatically.", search: false },
  { id: "recovery", label: "Recovery requests", icon: "lifebuoy", sub: "People who lost every sign-in method. Click a row to check their evidence.", search: true },
  { id: "settings", label: "Admin settings", icon: "settings", sub: "Your notification email — and, for the owner, the council policy.", search: false },
];

export default function AdminPage() {
  const router = useRouter();
  const { access, role, handle, profile } = useBetaAccess();
  const { theme, setTheme } = useTheme();
  const isAdmin = role === "admin" || role === "mod";

  const [data, setData] = useState<AdminData | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState<Tab>("imports");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const toastT = useRef<number | null>(null);
  const say = (m: string) => {
    setToast(m);
    if (toastT.current) window.clearTimeout(toastT.current);
    toastT.current = window.setTimeout(() => setToast(null), 2600);
  };

  // per-tab interaction state
  const [impSel, setImpSel] = useState<Set<string>>(new Set());
  const [impRejectId, setImpRejectId] = useState<string | null>(null);
  const [impReason, setImpReason] = useState(REJECT_REASONS[0]);
  const [fbOpen, setFbOpen] = useState<string | null>(null);
  const [flAdd, setFlAdd] = useState(false);
  const [flName, setFlName] = useState(""); const [flAddr, setFlAddr] = useState("");
  const [flType, setFlType] = useState("EOA"); const [flNotes, setFlNotes] = useState("");
  const [delPending, setDelPending] = useState<Friend | null>(null);
  const [appealOpen, setAppealOpen] = useState<string | null>(null);
  const [repStrikeId, setRepStrikeId] = useState<string | null>(null);
  const [amOpen, setAmOpen] = useState<string | null>(null);
  const [pplOpen, setPplOpen] = useState<string | null>(null);
  const [pplDetail, setPplDetail] = useState<Record<string, PersonDetail>>({});
  // Empty string IS unlimited here, mirroring the null in the database.
  const [genLimit, setGenLimit] = useState<string>("");
  const [repSev, setRepSev] = useState("1");
  const [cpHandle, setCpHandle] = useState(""); const [cpKind, setCpKind] = useState("ban_temp:7");
  const [cpViolation, setCpViolation] = useState("");
  const [seEmail, setSeEmail] = useState("");
  const [polEnabled, setPolEnabled] = useState(false);
  const [polQuorum, setPolQuorum] = useState("3"); const [polTtl, setPolTtl] = useState("7");
  const [recOpen, setRecOpen] = useState<string | null>(null);
  const [kebabOpen, setKebabOpen] = useState(false);
  const kebabRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!kebabOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) setKebabOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [kebabOpen]);

  useEffect(() => {
    if (access !== "ok" || !isAdmin) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/admin", { headers: sessionAuthHeaders() });
        if (!res.ok) throw new Error();
        const d = (await res.json()) as AdminData;
        if (!dead) setData(d);
      } catch {
        if (!dead) setLoadFailed(true);
      }
    })();
    return () => { dead = true; };
  }, [access, isAdmin]);

  const reload = async () => {
    try {
      const res = await fetch("/api/admin", { headers: sessionAuthHeaders() });
      if (res.ok) setData(await res.json());
    } catch { /* keep the current view */ }
  };

  // council settings mirror the freshest server state
  useEffect(() => {
    const c = data?.council;
    if (!c) return;
    setSeEmail(c.myEmail ?? "");
    setPolEnabled(c.enabled);
    setPolQuorum(String(c.quorum));
    setPolTtl(String(c.ttlDays));
  }, [data?.council]);

  // null (unlimited) becomes an empty field, which is what the input means.
  useEffect(() => {
    const g = data?.generation;
    if (!g) return;
    setGenLimit(g.maxConcurrentPerUser === null ? "" : String(g.maxConcurrentPerUser));
  }, [data?.generation]);

  const post = async (payload: Record<string, unknown>, okMsg: string, apply: (d: AdminData) => AdminData) => {
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify(payload),
      });
      const d = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) { say(d.error || "That didn't work."); return false; }
      setData((cur) => (cur ? apply(cur) : cur));
      if (okMsg) say(okMsg);
      return true;
    } catch {
      say("Network hiccup — nothing was changed.");
      return false;
    }
  };

  /** One person's events and failures, fetched when the row opens. */
  const loadPerson = async (id: string) => {
    try {
      const res = await fetch(`/api/admin?person=${encodeURIComponent(id)}`, { headers: sessionAuthHeaders() });
      if (res.ok) {
        const detail = (await res.json()) as PersonDetail;
        setPplDetail((cur) => ({ ...cur, [id]: detail }));
      }
    } catch { /* keep the current view */ }
  };
  const openPerson = async (id: string) => {
    if (pplOpen === id) { setPplOpen(null); return; }
    setPplOpen(id);
    if (!pplDetail[id]) await loadPerson(id);
  };
  /** An action changes counts on the server: refresh the list and the open person. */
  const act = async (payload: Record<string, unknown>, okMsg: string, personId: string) => {
    if (await post(payload, okMsg, (cur) => cur)) {
      await reload();
      await loadPerson(personId);
    }
  };

  const q = query.trim().toLowerCase();
  const tabDef = TABS.find((t) => t.id === tab)!;
  const counts = useMemo(() => ({
    // Needs attention: open cases only. A reviewed child-safety case keeps its flag on the row.
    people: data?.people.filter((p) => p.pending > 0).length ?? 0,
    imports: data?.imports.length ?? 0,
    reports: data?.reports.length ?? 0,
    feedback: data?.feedback.filter((f) => !f.paid).length ?? 0,
    friends: 0,
    hunters: 0,
    strikes: data?.strikes.filter((s) => s.appeal).length ?? 0,
    // Only the never-looked-at ones nag. A block that has been judged is
    // history, not a task.
    automod: data?.automod.filter((a) => a.state === "pending").length ?? 0,
    council: data?.council?.proposals.filter((p) => p.status === "pending").length ?? 0,
    recovery: data?.recovery.filter((r) => r.status === "pending").length ?? 0,
    settings: 0,
  }), [data]);

  /* ── gate states ── */
  if (access === "checking" || (access === "ok" && isAdmin && !data && !loadFailed)) {
    return (
      <div className="ek-app" style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, background: "var(--enki-paper)", color: "var(--enki-ink)" }}>
        <span style={{ color: "var(--enki-ember)", animation: "adm-pulse 1.1s infinite" }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /></svg>
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--enki-ink-3)" }}>Verifying admin access…</span>
        <style>{"@keyframes adm-pulse{0%,100%{opacity:.35}50%{opacity:1}}"}</style>
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="ek-app" style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "var(--enki-paper)" }}>
        <div style={{ maxWidth: 380, textAlign: "center", border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 16, background: "var(--enki-paper)", padding: "34px 30px" }}>
          <span style={{ color: "var(--enki-danger)", display: "inline-block", marginBottom: 10 }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m14.5 9.5-5 5" /><path d="m9.5 9.5 5 5" /></svg>
          </span>
          <h1 style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 26, fontWeight: 400, margin: "0 0 8px", color: "var(--enki-ink)" }}>Admins only.</h1>
          <p style={{ fontSize: 12.5, color: "var(--enki-ink-3)", lineHeight: 1.6, margin: "0 0 18px" }}>
            This area is for database admins. Your account doesn&apos;t have admin rights, so there&apos;s nothing for you here.
          </p>
          <button onClick={() => router.push("/home")} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 999, border: "none", background: "var(--enki-ink)", color: "var(--enki-paper)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            ← Back to Enki Art
          </button>
        </div>
      </div>
    );
  }

  const d: AdminData = data ?? { imports: [], reports: [], feedback: [], friends: [], hunters: [], strikes: [], recovery: [], council: COUNCIL_OFF, automod: [], people: [], generation: { maxConcurrentPerUser: null, canEdit: false } };
  const c = d.council ?? COUNCIL_OFF;
  const filteredImports = d.imports.filter((r) => !q || r.name.toLowerCase().includes(q) || r.hunter.toLowerCase().includes(q));
  const filteredFeedback = d.feedback.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.email ?? "").toLowerCase().includes(q) || r.desc.toLowerCase().includes(q));
  // Searching the prompt text matters most here: it is how you find every
  // block by one offender, or every block that shares a phrasing.
  const filteredAutomod = d.automod.filter((r) => !q
    || (r.category ?? "").toLowerCase().includes(q)
    || (r.handle ?? "").toLowerCase().includes(q)
    || r.surface.toLowerCase().includes(q)
    || r.rules.some((x) => x.toLowerCase().includes(q))
    || (r.prompt ?? "").toLowerCase().includes(q));
  const filteredPeople = d.people.filter((p) => !q || (p.handle ?? "").toLowerCase().includes(q) || (p.displayName ?? "").toLowerCase().includes(q) || p.key.includes(q));
  const filteredRecovery = d.recovery.filter((r) => !q || r.handle.toLowerCase().includes(q) || (r.contact ?? "").toLowerCase().includes(q));

  const stats: { label: string; value: number; dot: string; go: Tab }[] = [
    { label: "Pending imports", value: d.imports.length, dot: "var(--enki-ember)", go: "imports" },
    { label: "Open reports", value: d.reports.length, dot: "var(--enki-danger)", go: "reports" },
    { label: "Unpaid feedback", value: d.feedback.filter((f) => !f.paid).length, dot: "var(--enki-ember)", go: "feedback" },
    { label: "Active strikes", value: d.strikes.reduce((n, s) => n + s.strikes.length, 0), dot: "var(--enki-danger)", go: "strikes" },
    { label: "Open appeals", value: d.strikes.filter((s) => s.appeal).length, dot: "var(--enki-turq)", go: "strikes" },
    { label: "Recovery pending", value: d.recovery.filter((r) => r.status === "pending").length, dot: "var(--enki-turq)", go: "recovery" },
  ];

  const initials = ((profile?.handle || handle || "?") as string).slice(0, 2).toUpperCase();

  return (
    <div className="ek-app" style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--enki-paper-2)", color: "var(--enki-ink)", animation: "adm-fade .25s ease" }}>
      <style>{`
        @keyframes adm-fade{from{opacity:0}to{opacity:1}}
        @keyframes adm-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
        @keyframes adm-toast{from{opacity:0;transform:translateX(-50%) translateY(12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        @keyframes adm-pulse{0%,100%{opacity:.35}50%{opacity:1}}
        .adm-nav{display:flex;align-items:center;gap:10px;height:37px;padding:0 12px;border:none;border-radius:999px;background:transparent;color:${SB.nav};font-size:13px;width:100%;text-align:left;cursor:pointer;}
        .adm-nav:hover{background:rgba(255,255,255,.09);color:${SB.navOn};}
        .adm-nav.on{background:rgba(255,255,255,.12);color:${SB.navOn};font-weight:600;}
        .adm-off{display:flex;align-items:center;justify-content:center;gap:7px;height:36px;margin:0 2px 8px;border:1px solid rgba(201,104,56,.55);border-radius:999px;background:rgba(201,104,56,.14);color:${SB.emberText};font-size:12px;font-weight:600;cursor:pointer;width:calc(100% - 4px);}
        .adm-off:hover{background:rgba(201,104,56,.28);color:${SB.emberHover};}
        .adm-stat{border:1px solid var(--enki-rule-2,var(--enki-rule));border-radius:11px;background:var(--enki-paper);padding:9px 11px;text-align:left;cursor:pointer;}
        .adm-stat:hover,.adm-stat.on{border-color:var(--enki-ember);}
        .adm-kebab{opacity:0;transition:opacity .15s;width:24px;height:24px;border:none;border-radius:6px;background:none;color:${SB.muted};display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;}
        .adm-account:hover .adm-kebab{opacity:1;}
        .adm-kebab:hover{background:rgba(255,255,255,.1);color:${SB.navOn};}
      `}</style>

      {/* ── inverted admin sidebar (theme-independent by design) ── */}
      <aside style={{ width: 208, flexShrink: 0, display: "flex", flexDirection: "column", padding: "12px 10px 14px", background: SB.bg, color: SB.ink, overflowY: "auto" }}>
        <div style={{ padding: "4px 8px 10px" }}>
          <div style={{ fontFamily: MONO, fontSize: 8, letterSpacing: "0.22em", textTransform: "uppercase", color: SB.muted }}>Enki Art</div>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 22, color: SB.navOn }}>Admin.</span>
            <span style={{ fontFamily: MONO, fontSize: 7.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: SB.emberText, border: "1px solid rgba(201,104,56,0.55)", background: "rgba(201,104,56,0.16)", borderRadius: 4, padding: "2px 6px" }}>
              {role === "admin" ? "DB admin" : "Moderator"}
            </span>
          </div>
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {TABS.map((t) => (
            <button key={t.id} className={"adm-nav" + (tab === t.id ? " on" : "")} onClick={() => { setTab(t.id); setQuery(""); }}>
              <Icon name={t.icon} size={16} stroke={1.9} />
              <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.label}</span>
              {/* The count badge keeps the sidebar's own ember. --enki-ember now
                  follows the theme (gold / violet) and would clash with the fixed
                  warm accents right beside it. */}
              {counts[t.id] > 0 && (
                <span style={{ minWidth: 17, height: 17, padding: "0 5px", borderRadius: 999, background: SB.ember, color: SB.navOn, fontFamily: MONO, fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {counts[t.id]}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <button className="adm-off" onClick={() => router.push("/home")}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64A9 9 0 0 1 20.77 15" /><path d="M6.16 6.16a9 9 0 1 0 12.68 12.68" /><path d="M12 2v4" /></svg>
          Turn off admin mode
        </button>
        <div className="adm-account" ref={kebabRef} style={{ position: "relative", display: "flex", alignItems: "center", gap: 9, padding: "8px 8px 2px", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <span style={{ width: 32, height: 32, borderRadius: "50%", background: SB.navOn, color: SB.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 11, fontWeight: 600, overflow: "hidden", flexShrink: 0 }}>
            {profile?.avatarUrl
              ? /* eslint-disable-next-line @next/next/no-img-element */
                <img src={profile.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : initials}
          </span>
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: SB.navOn, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{handle || "you"}</span>
            <span style={{ fontSize: 11, color: SB.muted, fontFamily: MONO }}>@{handle || "—"}</span>
          </span>
          {/* 3-dot menu: theme mode lives here (hover to reveal) */}
          <button className="adm-kebab" title="Options" onClick={() => setKebabOpen((o) => !o)}>
            <Icon name="dots" size={15} stroke={2.2} />
          </button>
          {kebabOpen && (
            <div style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 4, zIndex: 40, minWidth: 168, background: SB.bg, border: "1px solid rgba(255,255,255,0.14)", borderRadius: 12, padding: 6, boxShadow: "0 14px 34px rgba(0,0,0,0.4)", animation: "adm-pop .15s ease" }}>
              <div style={{ fontFamily: MONO, fontSize: 8, letterSpacing: "0.14em", textTransform: "uppercase", color: SB.muted, padding: "4px 8px 6px" }}>Color theme</div>
              {THEME_OPTS.map((t) => (
                <button key={t.id} onClick={() => setTheme(t.id)} style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 8px", border: "none", borderRadius: 8, background: theme === t.id ? "rgba(255,255,255,0.1)" : "none", color: theme === t.id ? SB.navOn : SB.nav, fontSize: 12.5, fontWeight: theme === t.id ? 600 : 400, cursor: "pointer", textAlign: "left" }}>
                  <span style={{ width: 16, height: 16, borderRadius: 5, background: t.sw, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.25)", flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{t.name}</span>
                  {theme === t.id && <Icon name="check" size={13} stroke={2.6} />}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ── content ── */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "24px 26px 40px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <h1 style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 30, fontWeight: 400, margin: 0, lineHeight: 1, color: "var(--enki-ink)" }}>
              {tabDef.label.charAt(0).toUpperCase() + tabDef.label.slice(1)}.
            </h1>
            <p style={{ margin: 0, fontSize: 12, color: "var(--enki-ink-3)" }}>{tabDef.sub}</p>
            {tabDef.search && (
              <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, height: 30, border: "1px solid var(--enki-rule)", borderRadius: 999, background: "var(--enki-paper)", padding: "0 11px", width: 200 }}>
                <Icon name="search" size={12} stroke={2} style={{ color: "var(--enki-ink-3)" }} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", fontSize: 12, color: "var(--enki-ink)" }} />
              </span>
            )}
          </div>

          {loadFailed ? (
            <div style={{ padding: "50px 0", textAlign: "center", color: "var(--enki-ink-3)", fontSize: 13 }}>Could not load the moderation queues — refresh to retry.</div>
          ) : (
            <>
              {/* stat cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(138px, 1fr))", gap: 8, marginBottom: 14 }}>
                {stats.map((s) => (
                  <button key={s.label} className={"adm-stat" + (tab === s.go ? " on" : "")} onClick={() => { setTab(s.go); setQuery(""); }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.dot, flexShrink: 0 }} />
                      <span style={{ ...microLabel, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
                    </span>
                    <span style={{ display: "block", fontFamily: SERIF, fontSize: 23, fontWeight: 700, color: "var(--enki-ink)" }}>{s.value}</span>
                  </button>
                ))}
              </div>

              {/* ── PENDING IMPORTS ── */}
              {tab === "imports" && (
                <>
                  {impSel.size > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-3)" }}>{impSel.size} selected</span>
                      <Pill kind="green" label="Approve all" onClick={() => {
                        const ids = [...impSel];
                        void post({ resource: "imports", action: "approve", ids }, `${ids.length} imports approved.`, (cur) => ({ ...cur, imports: cur.imports.filter((r) => !impSel.has(r.id)) }));
                        setImpSel(new Set());
                      }} />
                      <Pill kind="red" label="Reject all" onClick={() => {
                        const ids = [...impSel];
                        void post({ resource: "imports", action: "reject", ids, reason: "Other" }, `${ids.length} imports rejected.`, (cur) => ({ ...cur, imports: cur.imports.filter((r) => !impSel.has(r.id)) }));
                        setImpSel(new Set());
                      }} />
                    </div>
                  )}
                  <div style={cardStyle}>
                    {filteredImports.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>Queue empty — all caught up ✓</div>}
                    {filteredImports.map((r) => (
                      <div key={r.id} style={{ ...rowStyle, background: impSel.has(r.id) ? "rgba(var(--ember-rgb), 0.05)" : "transparent" }}>
                        <input type="checkbox" checked={impSel.has(r.id)} onChange={() => setImpSel((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} style={{ accentColor: "var(--enki-ember, #c96838)" }} />
                        <span style={{ flex: 1.2, minWidth: 0 }}>
                          <span style={{ display: "block", fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                          {r.url && (
                            <a href={r.url} target="_blank" rel="noreferrer" style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ember)" }}>
                              {r.url.replace(/^https?:\/\//, "").slice(0, 30)}…
                            </a>
                          )}
                        </span>
                        <span style={{ width: 88, fontFamily: MONO, fontSize: 10.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>@{r.hunter}</span>
                        <span style={{ flex: 0.9, display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {r.tags.map((t) => <span key={t} style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--enki-ink-2)", background: "var(--enki-paper-2)", borderRadius: 4, padding: "2px 6px" }}>{t}</span>)}
                        </span>
                        <span style={{ width: 52, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)}</span>
                        {impRejectId === r.id ? (
                          <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
                            <select value={impReason} onChange={(e) => setImpReason(e.target.value)} style={{ height: 26, border: "1px solid var(--enki-rule)", borderRadius: 7, background: "var(--enki-paper)", color: "var(--enki-ink)", fontSize: 10.5 }}>
                              {REJECT_REASONS.map((x) => <option key={x}>{x}</option>)}
                            </select>
                            <Pill kind="red" label="Confirm" onClick={() => {
                              void post({ resource: "imports", action: "reject", id: r.id, reason: impReason }, `Rejected: ${impReason}.`, (cur) => ({ ...cur, imports: cur.imports.filter((x) => x.id !== r.id) }));
                              setImpRejectId(null);
                            }} />
                            <Pill kind="plain" label="Cancel" onClick={() => setImpRejectId(null)} />
                          </span>
                        ) : (
                          <span style={{ display: "flex", gap: 5 }}>
                            <Pill kind="green" label="Approve" onClick={() => void post({ resource: "imports", action: "approve", id: r.id }, `“${r.name}” approved — it's live.`, (cur) => ({ ...cur, imports: cur.imports.filter((x) => x.id !== r.id) }))} />
                            <Pill kind="red" label="Reject" onClick={() => setImpRejectId(r.id)} />
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* ── REPORTS ── */}
              {tab === "reports" && (
                <div style={cardStyle}>
                  {d.reports.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No open reports ✓</div>}
                  {d.reports.map((r) => (
                    <div key={r.id} style={rowStyle}>
                      <span style={{ width: 30, textAlign: "center", fontFamily: MONO, fontSize: 15, fontWeight: 700, color: typeof r.severity === "number" && r.severity >= 3 ? "var(--enki-danger)" : "var(--enki-ink)" }}>!</span>
                      <span style={{ flex: 1, minWidth: 0, fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r.details ?? undefined}>{r.target}</span>
                      <Badge pal={r.type === "prompt" ? PILL.blue : PILL.amber} label={r.type} />
                      <span style={{ width: 90, fontSize: 11, color: "var(--enki-ink-2)", overflow: "hidden", textOverflow: "ellipsis" }}>{r.reason}</span>
                      <span style={{ width: 76, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>@{r.reporter}</span>
                      <span style={{ width: 40, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)}</span>
                      {repStrikeId === r.id ? (
                        <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
                          <select value={repSev} onChange={(e) => setRepSev(e.target.value)} style={{ height: 26, border: "1px solid var(--enki-rule)", borderRadius: 7, background: "var(--enki-paper)", color: "var(--enki-ink)", fontSize: 10.5 }}>
                            {["1", "2", "3"].map((s) => <option key={s} value={s}>Severity {s}</option>)}
                          </select>
                          <Pill kind="red" label="Confirm" onClick={() => {
                            void post({ resource: "reports", action: "strike", id: r.id, severity: Number(repSev) }, "Strike issued — report closed.", (cur) => ({ ...cur, reports: cur.reports.filter((x) => x.id !== r.id) }));
                            setRepStrikeId(null);
                          }} />
                          <Pill kind="plain" label="Cancel" onClick={() => setRepStrikeId(null)} />
                        </span>
                      ) : (
                        <span style={{ display: "flex", gap: 5 }}>
                          {r.type === "prompt" && <Pill kind="amber" label="Delist" onClick={() => void post({ resource: "reports", action: "delist", id: r.id }, "Prompt delisted — report closed.", (cur) => ({ ...cur, reports: cur.reports.filter((x) => x.id !== r.id) }))} />}
                          <Pill kind="red" label="Strike" title="Strike the reported user and close the report" onClick={() => { setRepSev("1"); setRepStrikeId(r.id); }} />
                          <Pill kind="green" label="Resolve" onClick={() => void post({ resource: "reports", action: "resolve", id: r.id }, "Report resolved.", (cur) => ({ ...cur, reports: cur.reports.filter((x) => x.id !== r.id) }))} />
                          <Pill kind="plain" label="Dismiss" onClick={() => void post({ resource: "reports", action: "dismiss", id: r.id }, "Report dismissed.", (cur) => ({ ...cur, reports: cur.reports.filter((x) => x.id !== r.id) }))} />
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── FEEDBACK ── */}
              {tab === "feedback" && (
                <div style={cardStyle}>
                  {filteredFeedback.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No feedback yet.</div>}
                  {filteredFeedback.map((r) => (
                    <div key={r.id}>
                      <div style={{ ...rowStyle, cursor: "pointer" }} onClick={() => setFbOpen((v) => (v === r.id ? null : r.id))}>
                        <span style={{ width: 116, fontSize: 12, fontWeight: 600, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                        <span style={{ width: 132, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>{r.email ?? "—"}</span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--enki-ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.desc}</span>
                        <span style={{ width: 34, textAlign: "center", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{r.images > 0 ? `${r.images} img` : "—"}</span>
                        <span style={{ width: 42, fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)}</span>
                        <Badge pal={r.paid ? PILL.green : PILL.amber} label={r.paid ? "Paid" : "Unpaid"} />
                        {!r.paid && (
                          <span onClick={(e) => e.stopPropagation()}>
                            <Pill kind="green" label="Mark paid" onClick={() => void post({ resource: "feedback", action: "markPaid", id: r.id }, `$100 payout marked as paid to ${r.name}.`, (cur) => ({ ...cur, feedback: cur.feedback.map((x) => (x.id === r.id ? { ...x, paid: true } : x)) }))} />
                          </span>
                        )}
                      </div>
                      {fbOpen === r.id && (
                        <div style={{ padding: "2px 0 12px 10px", borderLeft: `3px solid ${PILL.amber.border}`, margin: "0 0 8px 4px" }}>
                          <p style={{ margin: 0, fontSize: 12, color: "var(--enki-ink-2)", lineHeight: 1.65, maxWidth: 640 }}>{r.desc}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── FRIENDS (WHITELIST) ── */}
              {tab === "friends" && (
                <>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                    <button onClick={() => setFlAdd((v) => !v)} style={{ padding: "5px 14px", borderRadius: 999, border: "none", background: "var(--enki-ink)", color: "var(--enki-paper)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                      {flAdd ? "Close" : "+ Add entry"}
                    </button>
                  </div>
                  {flAdd && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 7, border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 11, background: "var(--enki-paper)", padding: "10px 12px", marginBottom: 8 }}>
                      {([
                        ["Name", flName, setFlName, 1, false],
                        ["Address / collection ID", flAddr, setFlAddr, 1.4, true],
                        ["Notes", flNotes, setFlNotes, 1.2, false],
                      ] as [string, string, (v: string) => void, number, boolean][]).map(([ph, val, set, grow, mono]) => (
                        <input key={ph} placeholder={ph} value={val} onChange={(e) => set(e.target.value)} style={{ flex: grow, minWidth: 110, height: 28, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", fontFamily: mono ? MONO : undefined, outline: "none" }} />
                      ))}
                      <select value={flType} onChange={(e) => setFlType(e.target.value)} style={{ height: 28, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5 }}>
                        {["EOA", "Collection", "Multi-sig"].map((t) => <option key={t}>{t}</option>)}
                      </select>
                      {/* network picker — greyed out until there is more than Solana */}
                      <select value="solana" disabled title="More networks are coming — Solana is the only one for now"
                        style={{ height: 28, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink-3)", fontSize: 11.5, opacity: 0.55, cursor: "not-allowed" }}>
                        <option value="solana">Solana</option>
                      </select>
                      <Pill kind="green" label="Save" onClick={() => {
                        if (!flName.trim() || !flAddr.trim()) { say("Name and address are required."); return; }
                        void (async () => {
                          const ok = await post({ resource: "friends", action: "add", name: flName, address: flAddr, type: flType, notes: flNotes }, "Whitelist entry added.", (cur) => cur);
                          if (ok) {
                            setFlAdd(false); setFlName(""); setFlAddr(""); setFlNotes("");
                            // re-fetch to pick up the server-assigned id
                            try {
                              const res = await fetch("/api/admin", { headers: sessionAuthHeaders() });
                              if (res.ok) setData(await res.json());
                            } catch { /* next visit reconciles */ }
                          }
                        })();
                      }} />
                    </div>
                  )}
                  <div style={cardStyle}>
                    {d.friends.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>Whitelist is empty.</div>}
                    {d.friends.map((r) => (
                      <div key={r.id} style={rowStyle}>
                        <span style={{ width: 140, fontSize: 12.5, fontWeight: 600, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                        <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 10.5, color: "var(--enki-ink-2)", overflow: "hidden", textOverflow: "ellipsis" }}>{r.address}</span>
                        <Badge pal={PILL.blue} label={r.type} />
                        <Badge pal={{ bg: "var(--enki-paper-2)", ink: "var(--enki-ink-2)" }} label={r.chain} />
                        <span style={{ flex: 1, fontSize: 11, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.notes ?? "—"}</span>
                        <Pill kind="red" label="Delete" onClick={() => setDelPending(r)} />
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* ── HUNTER TRUST ── */}
              {tab === "hunters" && (
                <div style={cardStyle}>
                  {d.hunters.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No hunter activity yet.</div>}
                  {d.hunters.map((r) => {
                    const score = r.total > 0 ? Math.round((r.approved / r.total) * 100) : 0;
                    const col = score >= 80 ? "var(--enki-turq)" : score >= 50 ? "var(--enki-ember)" : "var(--enki-danger)";
                    return (
                      <div key={r.handle} style={{ ...rowStyle, gap: 12, padding: "10px 0" }}>
                        <span style={{ width: 110, fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: "var(--enki-ink)" }}>@{r.handle}</span>
                        <span style={{ width: 66, fontSize: 11, color: "var(--enki-ink-3)" }}>{r.total} total</span>
                        <Badge pal={PILL.green} label={`${r.approved} ✓`} />
                        <Badge pal={PILL.red} label={`${r.denied} ✗`} />
                        <span style={{ flex: 1, minWidth: 60, height: 5, borderRadius: 3, background: "var(--enki-rule-2, var(--enki-rule))", overflow: "hidden" }}>
                          <span style={{ display: "block", height: "100%", width: `${score}%`, background: col, borderRadius: 3 }} />
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: col }}>{score}%</span>
                        <span style={{ width: 56, textAlign: "right", fontFamily: MONO, fontSize: 12, fontWeight: 700, color: "var(--enki-ember)" }}>{dollars(r.earningsCents)}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── STRIKES & BANS ── */}
              {tab === "strikes" && (
                <div style={cardStyle}>
                  {d.strikes.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No active strikes, bans or appeals ✓</div>}
                  {d.strikes.map((r) => {
                    const n = r.strikes.length;
                    return (
                      <div key={r.userId}>
                        <div style={rowStyle}>
                          <span style={{ width: 116, fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis" }}>@{r.handle}</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            {[0, 1, 2].map((i) => <span key={i} style={{ width: 9, height: 9, borderRadius: "50%", background: i < Math.min(n, 3) ? "var(--enki-danger)" : "var(--enki-rule-2, var(--enki-rule))" }} />)}
                            <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)", marginLeft: 2 }}>{n}/3</span>
                          </span>
                          <Badge pal={r.banned ? PILL.red : { bg: "var(--enki-paper-2)", ink: "var(--enki-ink-2)" } as { bg: string; ink: string }} label={r.permanent ? "permbanned" : r.banned ? "banned" : "active"} />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.note ?? "—"}</span>
                          {r.appeal && (
                            <button onClick={() => setAppealOpen((v) => (v === r.userId ? null : r.userId))} style={{ padding: "3px 9px", borderRadius: 999, border: `1px solid ${PILL.purple.border}`, background: PILL.purple.bg, color: PILL.purple.ink, fontSize: 9.5, fontWeight: 600, cursor: "pointer" }}>
                              Appeal filed
                            </button>
                          )}
                          {n > 0 && (
                            <Pill kind="plain" label="Revoke" title="Revoke the newest active strike"
                              onClick={() => void post({ resource: "strikes", action: "revoke", id: r.strikes[0].id }, `Strike revoked for @${r.handle}.`, (cur) => ({
                                ...cur,
                                strikes: cur.strikes
                                  .map((x) => (x.userId === r.userId ? { ...x, strikes: x.strikes.slice(1) } : x))
                                  .filter((x) => x.strikes.length > 0 || x.banned || x.appeal),
                              }))} />
                          )}
                          {!r.banned && (
                            <Pill kind="red" label={c.enabled ? "Propose ban" : "Ban 7d"} title={c.enabled ? "Propose a 7-day ban to the council" : "Full ban, expires in 7 days"}
                              onClick={() => c.enabled
                                ? void post({ resource: "council", action: "propose", kind: "ban_temp", days: 7, userId: r.userId, violation: r.note ?? "Repeated strikes" }, "Proposal sent — council notified.", (cur) => cur)
                                : void post({ resource: "bans", action: "ban", userId: r.userId, days: 7 }, `@${r.handle} banned for 7 days.`, (cur) => ({
                                    ...cur, strikes: cur.strikes.map((x) => (x.userId === r.userId ? { ...x, banned: true, permanent: false } : x)),
                                  }))} />
                          )}
                          {!r.permanent && (
                            <Pill kind="red" label={c.enabled ? "Propose permban" : "Permban"} title={c.enabled ? "Propose a permanent ban to the council" : "Full ban, no expiry"}
                              onClick={() => c.enabled
                                ? void post({ resource: "council", action: "propose", kind: "ban_perm", userId: r.userId, violation: r.note ?? "Repeated strikes" }, "Proposal sent — council notified.", (cur) => cur)
                                : void post({ resource: "bans", action: "ban", userId: r.userId, permanent: true }, `@${r.handle} permanently banned.`, (cur) => ({
                                    ...cur, strikes: cur.strikes.map((x) => (x.userId === r.userId ? { ...x, banned: true, permanent: true } : x)),
                                  }))} />
                          )}
                          {r.banned && (
                            <Pill kind="green" label="Reinstate" title="Lift the active ban"
                              onClick={() => void post({ resource: "bans", action: "lift", userId: r.userId }, `@${r.handle} reinstated.`, (cur) => ({
                                ...cur,
                                strikes: cur.strikes
                                  .map((x) => (x.userId === r.userId ? { ...x, banned: false, permanent: false } : x))
                                  .filter((x) => x.strikes.length > 0 || x.banned || x.appeal),
                              }))} />
                          )}
                        </div>
                        {appealOpen === r.userId && r.appeal && (
                          <div style={{ padding: "2px 0 12px 10px", borderLeft: `3px solid ${PILL.purple.border}`, margin: "0 0 8px 4px" }}>
                            <span style={{ ...microLabel, display: "block", marginBottom: 4 }}>Appeal note</span>
                            <p style={{ margin: 0, fontSize: 12, fontStyle: "italic", color: "var(--enki-ink-2)", lineHeight: 1.6, maxWidth: 640 }}>
                              “{r.appeal.note ?? "No statement provided."}”
                            </p>
                            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                              <Pill kind="green" label="Approve" title="Approve the appeal — the appealed strike/ban is undone" onClick={() => {
                                const apId = r.appeal!.id;
                                setAppealOpen(null);
                                void (async () => {
                                  const ok = await post({ resource: "appeals", action: "approve", id: apId }, "Appeal approved — the strike/ban was undone.", (cur) => cur);
                                  // the server revoked/lifted the target — re-fetch so the row reflects it
                                  if (ok) await reload();
                                })();
                              }} />
                              <Pill kind="red" label="Deny" onClick={() => {
                                const apId = r.appeal!.id;
                                setAppealOpen(null);
                                void post({ resource: "appeals", action: "deny", id: apId }, "Appeal denied.", (cur) => ({
                                  ...cur,
                                  strikes: cur.strikes
                                    .map((x) => (x.userId === r.userId ? { ...x, appeal: null } : x))
                                    .filter((x) => x.strikes.length > 0 || x.banned || x.appeal),
                                }));
                              }} />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── PEOPLE: one row per person, every warning and failure on expanding ── */}
              {tab === "people" && (
                <div style={cardStyle}>
                  {filteredPeople.length === 0 && (
                    <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>
                      {d.people.length === 0 ? "Nobody was warned, blocked or failed this week ✓" : "Nothing matches that search."}
                    </div>
                  )}
                  {filteredPeople.map((p) => {
                    const detail = pplDetail[p.key];
                    const name = p.handle ? `@${p.handle}` : p.displayName ?? (p.userId ? p.userId.slice(0, 8) : `no account · ${p.ipHash?.slice(0, 8)}`);
                    return (
                      <div key={p.key}>
                        <div style={{ ...rowStyle, cursor: "pointer" }} onClick={() => void openPerson(p.key)}>
                          <span style={{ width: 130, fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                          {p.childSafety && <Badge pal={PILL.red} label="child safety" />}
                          <span style={{ fontFamily: MONO, fontSize: 10, color: p.warnings > 0 ? "var(--enki-danger)" : "var(--enki-ink-3)" }}>{p.warnings} warnings</span>
                          {p.extractionHits > 0 && <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--enki-ember)" }}>{p.extractionHits} extraction</span>}
                          {p.failed7d > 0 && <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-2)" }}>{p.failed7d} failed (7d)</span>}
                          {p.pending > 0 && <Badge pal={PILL.purple} label={`${p.pending} to review`} />}
                          {p.suspension && <Badge pal={PILL.red} label={p.suspension.until ? `suspended until ${p.suspension.until.slice(0, 10)}` : "suspended for good"} />}
                          <span style={{ flex: 1 }} />
                          {p.suspension && p.userId && (
                            <span onClick={(e) => e.stopPropagation()}>
                              <Pill kind="green" label="Lift" title="Lift the running suspension"
                                onClick={() => void act({ resource: "bans", action: "lift", userId: p.userId }, `${name} reinstated.`, p.key)} />
                            </span>
                          )}
                          <span style={{ width: 52, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{p.lastActive ? timeAgo(p.lastActive) : "—"}</span>
                        </div>
                        {pplOpen === p.key && (
                          <div style={{ padding: "4px 0 14px 10px", borderLeft: "3px solid var(--enki-rule)", margin: "0 0 8px 4px", display: "flex", flexDirection: "column", gap: 10 }}>
                            {!detail && <span style={{ fontSize: 11, color: "var(--enki-ink-3)" }}>Loading…</span>}
                            {detail && detail.events.length === 0 && detail.failures.length === 0 && <span style={{ fontSize: 11, color: "var(--enki-ink-3)" }}>No events.</span>}
                            {detail?.events.map((e) => (
                              <div key={e.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                  <Badge pal={e.category && ["minor_sexual", "sexual/minors", "csam"].includes(e.category) ? PILL.red : PILL.purple} label={e.category ?? e.severity} />
                                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)" }}>
                                    {e.surface}{e.weight ? ` · weight ${e.weight}` : ""}{e.confidence !== null ? ` · ${e.confidence.toFixed(2)}` : ""}{e.rules.length ? ` · ${e.rules.join(", ")}` : ""} · {e.state} · {timeAgo(e.at)}
                                  </span>
                                  {e.state !== "overturned" && e.state !== "upheld" && (
                                    <>
                                      <Pill kind="plain" label="Overturn" title="Wrongly caught: take it out of every count"
                                        onClick={() => void act({ resource: "automod", action: "overturn", id: e.id }, "Overturned.", p.key)} />
                                      <Pill kind="plain" label="Mark reviewed" title="Correctly caught"
                                        onClick={() => void act({ resource: "automod", action: "uphold", id: e.id }, "Marked reviewed.", p.key)} />
                                    </>
                                  )}
                                </div>
                                <p style={{ margin: 0, fontFamily: MONO, fontSize: 11, color: "var(--enki-ink-2)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxWidth: 760 }}>{e.prompt ?? "Not readable."}</p>
                              </div>
                            ))}
                            {detail?.failures.map((x) => (
                              <div key={x.id} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                {/* eslint-disable-next-line @next/next/no-img-element -- admin-only thumbnail of a stored image */}
                                {x.imageUrl && <img src={x.imageUrl} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6 }} />}
                                <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                    <Badge pal={PILL.red} label="failed" />
                                    <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)" }}>
                                      {x.surface} · {x.model ?? "?"} · {x.resolution ?? "?"}{x.quality ? ` · ${x.quality}` : ""}{x.boost ? " · boost" : ""}{x.aspectRatio ? ` · ${x.aspectRatio}` : ""}{x.referenceImageCount ? ` · ${x.referenceImageCount} refs` : ""} · {timeAgo(x.at)}
                                    </span>
                                  </div>
                                  <span style={{ fontSize: 11, color: "var(--enki-danger)", wordBreak: "break-word" }}>{x.error}</span>
                                  <p style={{ margin: 0, fontFamily: MONO, fontSize: 11, color: "var(--enki-ink-2)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxWidth: 760 }}>{x.prompt ?? "Not readable."}</p>
                                  {x.txSignature && <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>paid: {x.txSignature}</span>}
                                </div>
                              </div>
                            ))}
                            {detail && detail.bans.length > 0 && (
                              <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)" }}>
                                Bans: {detail.bans.map((b) => `${b.at.slice(0, 10)} ${b.liftedAt ? "lifted" : b.expiresAt ? `until ${b.expiresAt.slice(0, 10)}` : "for good"}`).join(" · ")}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── AUTO-FILTER LOG ── */}
              {tab === "automod" && (
                <div style={cardStyle}>
                  {filteredAutomod.length === 0 && (
                    <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>
                      {d.automod.length === 0 ? "The filter hasn't blocked anything ✓" : "Nothing matches that search."}
                    </div>
                  )}
                  {filteredAutomod.map((r) => (
                    <div key={r.id}>
                      <div
                        style={{ ...rowStyle, cursor: "pointer" }}
                        onClick={() => setAmOpen(amOpen === r.id ? null : r.id)}
                      >
                        <span style={{ width: 30, textAlign: "center", fontFamily: MONO, fontSize: 15, fontWeight: 700, color: r.severity === "review" ? "var(--enki-danger)" : "var(--enki-ink-3)" }}>
                          {r.tier === 1 ? "1" : r.tier === 2 ? "2" : "—"}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.category ?? "blocked"}
                        </span>
                        <Badge pal={r.severity === "review" ? PILL.red : PILL.amber} label={r.severity} />
                        <span style={{ width: 96, fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-2)", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.topScore ? `${r.topScore.name.split("/").pop()} ${r.topScore.value.toFixed(2)}` : r.rules[0] ?? "—"}
                        </span>
                        <span style={{ width: 76, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.handle ? "@" + r.handle : "anon"}
                        </span>
                        <span style={{ width: 58, fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)", overflow: "hidden" }}>{r.surface.replace("generate-", "")}</span>
                        <span style={{ width: 40, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)}</span>
                        {r.state === "pending" && <Badge pal={PILL.amber} label="unreviewed" />}
                      </div>
                      {amOpen === r.id && (
                        <div style={{ padding: "12px 18px 16px", borderBottom: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)" }}>
                          <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--enki-ink-3)", marginBottom: 6 }}>
                            Blocked prompt
                          </div>
                          <div style={{ fontFamily: SERIF, fontSize: 13.5, lineHeight: 1.5, color: "var(--enki-ink)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                            {r.prompt ?? <em style={{ color: "var(--enki-ink-3)" }}>Not readable — encrypted with a key this server no longer holds.</em>}
                          </div>
                          {r.rules.length > 0 && (
                            <div style={{ marginTop: 10, fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-2)" }}>
                              rules: {r.rules.join(", ")}
                            </div>
                          )}
                          <div style={{ marginTop: 10, fontSize: 11, color: "var(--enki-ink-3)" }}>
                            This row is evidence and is never deleted. Overturn or confirm it per person in People.
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── COUNCIL ── */}
              {tab === "council" && (!c.ready ? (
                <div style={{ ...cardStyle, padding: "26px 18px", textAlign: "center", fontSize: 12.5, color: "var(--enki-ink-3)" }}>
                  The council isn&apos;t set up yet — run <span style={{ fontFamily: MONO }}>migrations/2026-07-21-moderation-council.sql</span> in Supabase, then refresh.
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-3)" }}>
                    <Badge pal={c.enabled ? PILL.green : PILL.amber} label={c.enabled ? "Council mode ON" : "Council mode OFF"} />
                    <span>quorum {c.quorum} of {c.members.length} · proposals expire after {c.ttlDays}d{c.enabled ? "" : " · while off, proposals execute immediately"}</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7, border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 11, background: "var(--enki-paper)", padding: "10px 12px", marginBottom: 8 }}>
                    <input placeholder="@handle" value={cpHandle} onChange={(e) => setCpHandle(e.target.value)} style={{ width: 130, height: 28, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", fontFamily: MONO, outline: "none" }} />
                    <select value={cpKind} onChange={(e) => setCpKind(e.target.value)} style={{ height: 28, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5 }}>
                      <option value="ban_temp:7">Ban 7 days</option>
                      <option value="ban_temp:30">Ban 30 days</option>
                      <option value="ban_perm">Permanent ban</option>
                      <option value="ip_ban">IP ban (indefinite)</option>
                    </select>
                    <input placeholder="Violation — what rule did they break?" value={cpViolation} onChange={(e) => setCpViolation(e.target.value)} style={{ flex: 1, minWidth: 160, height: 28, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", outline: "none" }} />
                    <Pill kind="red" label={c.enabled ? "Propose to council" : "Execute now"} onClick={() => {
                      if (!cpHandle.trim() || !cpViolation.trim()) { say("Handle and violation are required."); return; }
                      const [kind, days] = cpKind.split(":");
                      void (async () => {
                        const ok = await post(
                          { resource: "council", action: "propose", kind, days: days ? Number(days) : undefined, handle: cpHandle.trim(), violation: cpViolation.trim() },
                          c.enabled ? "Proposal sent — council notified by email." : "Executed.",
                          (cur) => cur,
                        );
                        if (ok) { setCpHandle(""); setCpViolation(""); await reload(); }
                      })();
                    }} />
                  </div>
                  <div style={cardStyle}>
                    {c.proposals.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No proposals yet.</div>}
                    {c.proposals.map((p) => {
                      const kindLabel = p.kind === "ip_ban" ? "IP ban" : p.kind === "ban_perm" ? "Permban" : `Ban ${p.days ?? 7}d`;
                      const statusPal =
                        p.status === "approved" ? PILL.green
                        : p.status === "denied" ? PILL.red
                        : { bg: "var(--enki-paper-2)", ink: "var(--enki-ink-2)" } as { bg: string; ink: string };
                      return (
                        <div key={p.id} style={rowStyle}>
                          <Badge pal={p.kind === "ban_temp" ? PILL.amber : PILL.red} label={kindLabel} />
                          <span style={{ width: 106, fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis" }}>{p.target}</span>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--enki-ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.violation}>{p.violation}</span>
                          <span style={{ width: 78, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>by @{p.proposer}</span>
                          <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-2)", whiteSpace: "nowrap" }}>
                            {p.confirms}✓ {p.denies}✗ <span style={{ color: "var(--enki-ink-3)" }}>/ {p.quorum}</span>
                          </span>
                          {p.status === "pending" ? (
                            <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
                              <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(p.at)}</span>
                              <Pill kind="green" label={p.myVote === "confirm" ? "Confirmed ✓" : "Confirm"}
                                onClick={p.myVote === "confirm" ? undefined : () => void (async () => {
                                  const ok = await post({ resource: "council", action: "vote", id: p.id, vote: "confirm" }, "Vote recorded.", (cur) => cur);
                                  if (ok) await reload();
                                })()} />
                              <Pill kind="red" label={p.myVote === "deny" ? "Denied ✗" : "Deny"}
                                onClick={p.myVote === "deny" ? undefined : () => void (async () => {
                                  const ok = await post({ resource: "council", action: "vote", id: p.id, vote: "deny" }, "Vote recorded.", (cur) => cur);
                                  if (ok) await reload();
                                })()} />
                            </span>
                          ) : (
                            <Badge pal={statusPal} label={p.status} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              ))}

              {/* ── RECOVERY REQUESTS ── */}
              {tab === "recovery" && (
                <div style={cardStyle}>
                  {filteredRecovery.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No recovery requests.</div>}
                  {filteredRecovery.map((r) => {
                    const statusPal =
                      r.status === "approved" ? PILL.green
                      : r.status === "rejected" ? PILL.red
                      : r.status === "needs_info" ? PILL.amber
                      : { bg: "var(--enki-paper-2)", ink: "var(--enki-ink-2)" } as { bg: string; ink: string };
                    return (
                      <div key={r.id}>
                        <div style={{ ...rowStyle, cursor: "pointer" }} onClick={() => setRecOpen((v) => (v === r.id ? null : r.id))}>
                          <span style={{ width: 112, fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis" }}>@{r.handle}</span>
                          <span style={{ width: 168, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>{r.contact ?? "—"}</span>
                          <span style={{ flex: 1, display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {r.evidence.length === 0
                              ? <Badge pal={PILL.red} label="minimal evidence" />
                              : r.evidence.map((e, i) => (
                                  <Badge key={i}
                                    pal={e.kind.toLowerCase().includes("zkp") ? PILL.purple : { bg: "var(--enki-paper-2)", ink: "var(--enki-ink-2)" } as { bg: string; ink: string }}
                                    label={e.kind + (e.matched ? " ✓" : "")} />
                                ))}
                          </span>
                          <span style={{ width: 42, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)}</span>
                          <Badge pal={statusPal} label={r.status === "needs_info" ? "Needs info" : r.status.charAt(0).toUpperCase() + r.status.slice(1)} />
                          <span style={{ display: "flex", gap: 5 }} onClick={(e) => e.stopPropagation()}>
                            {r.status === "pending" && <>
                              <Pill kind="green" label="Approve" onClick={() => void post({ resource: "recovery", action: "setStatus", id: r.id, status: "approved" }, `Access restored for @${r.handle}.`, (cur) => ({ ...cur, recovery: cur.recovery.map((x) => (x.id === r.id ? { ...x, status: "approved" } : x)) }))} />
                              <Pill kind="plain" label="Need more" onClick={() => void post({ resource: "recovery", action: "setStatus", id: r.id, status: "needs_info" }, "", (cur) => ({ ...cur, recovery: cur.recovery.map((x) => (x.id === r.id ? { ...x, status: "needs_info" } : x)) }))} />
                              <Pill kind="red" label="Reject" onClick={() => void post({ resource: "recovery", action: "setStatus", id: r.id, status: "rejected" }, "", (cur) => ({ ...cur, recovery: cur.recovery.map((x) => (x.id === r.id ? { ...x, status: "rejected" } : x)) }))} />
                            </>}
                            {r.status === "needs_info" && (
                              <Pill kind="plain" label="Re-review" onClick={() => void post({ resource: "recovery", action: "setStatus", id: r.id, status: "pending" }, "", (cur) => ({ ...cur, recovery: cur.recovery.map((x) => (x.id === r.id ? { ...x, status: "pending" } : x)) }))} />
                            )}
                          </span>
                        </div>
                        {recOpen === r.id && (
                          <div style={{ padding: "4px 0 12px 10px", borderLeft: `3px solid ${PILL.blue.border}`, margin: "0 0 8px 4px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 26px", maxWidth: 720 }}>
                            <span><span style={{ ...microLabel, display: "block" }}>Wallet address</span><span style={{ fontSize: 11.5, fontFamily: MONO, color: "var(--enki-ink-2)" }}>{r.wallet ?? "Not submitted"}</span></span>
                            <span><span style={{ ...microLabel, display: "block" }}>Contact</span><span style={{ fontSize: 11.5, fontFamily: MONO, color: "var(--enki-ink-2)" }}>{r.contact ?? "Not submitted"}</span></span>
                            <span style={{ gridColumn: "1 / -1" }}>
                              <span style={{ ...microLabel, display: "block" }}>Explanation</span>
                              <span style={{ fontSize: 12, color: "var(--enki-ink-2)", lineHeight: 1.65, display: "block", maxWidth: 640 }}>{r.explanation ?? "—"}</span>
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* ── ADMIN SETTINGS ── */}
              {tab === "settings" && (!c.ready ? (
                <div style={{ ...cardStyle, padding: "26px 18px", textAlign: "center", fontSize: 12.5, color: "var(--enki-ink-3)" }}>
                  Admin settings need the council tables — run <span style={{ fontFamily: MONO }}>migrations/2026-07-21-moderation-council.sql</span> in Supabase, then refresh.
                </div>
              ) : (
                <>
                  {/* Generation throttle — visible to mods, editable by admins.
                      Slowing the product for everyone is not a moderation call. */}
                  <div style={{ ...cardStyle, padding: "14px 16px", marginBottom: 10, maxWidth: 560 }}>
                    <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 17, color: "var(--enki-ink)", marginBottom: 4 }}>Generation limit.</div>
                    <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--enki-ink-3)", lineHeight: 1.55 }}>
                      How many generations one user may have running at the same time. Empty means
                      unlimited, which is how it ships. {d.generation.canEdit
                        ? "Takes effect immediately — no deploy."
                        : "Admins only — you can see it, but not change it."}
                    </p>
                    <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                      <input
                        type="number" min={1} max={100} placeholder="unlimited"
                        value={genLimit}
                        disabled={!d.generation.canEdit}
                        onChange={(e) => setGenLimit(e.target.value)}
                        style={{ width: 120, height: 30, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", fontFamily: MONO, outline: "none", opacity: d.generation.canEdit ? 1 : 0.5 }}
                      />
                      {d.generation.canEdit && (
                        <Pill kind="green" label="Save" onClick={() => {
                          const raw = genLimit.trim();
                          const value = raw === "" ? null : Number(raw);
                          void post(
                            { resource: "generation", action: "setConcurrency", maxConcurrentPerUser: value },
                            value === null ? "Generation limit removed — unlimited." : `Limit set to ${value} at a time.`,
                            (cur) => ({ ...cur, generation: { ...cur.generation, maxConcurrentPerUser: value } }),
                          );
                        }} />
                      )}
                    </div>
                  </div>

                  <div style={{ ...cardStyle, padding: "14px 16px", marginBottom: 10, maxWidth: 560 }}>
                    <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 17, color: "var(--enki-ink)", marginBottom: 4 }}>Council notifications.</div>
                    <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--enki-ink-3)", lineHeight: 1.55 }}>
                      Council vote requests are mailed here. Stored encrypted — leave empty to opt out of emails (you still vote in this panel).
                    </p>
                    <div style={{ display: "flex", gap: 7 }}>
                      <input placeholder="you@example.com" value={seEmail} onChange={(e) => setSeEmail(e.target.value)} style={{ flex: 1, height: 30, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", fontFamily: MONO, outline: "none" }} />
                      <Pill kind="green" label="Save" onClick={() => {
                        const email = seEmail.trim();
                        void post({ resource: "prefs", action: "setEmail", email }, email ? "Notification email saved." : "Notification email cleared.",
                          (cur) => ({ ...cur, council: { ...cur.council, myEmail: email || null } }));
                      }} />
                    </div>
                  </div>
                  {c.isOwner && (
                    <div style={{ ...cardStyle, padding: "14px 16px", maxWidth: 560 }}>
                      <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 17, color: "var(--enki-ink)", marginBottom: 4 }}>Moderation policy.</div>
                      <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--enki-ink-3)", lineHeight: 1.55 }}>
                        Owner only. With council mode on, no single admin can ban — every ban executes only after the quorum confirms it.
                      </p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 10 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--enki-ink)", cursor: "pointer" }}>
                          <input type="checkbox" checked={polEnabled} onChange={(e) => setPolEnabled(e.target.checked)} style={{ accentColor: "var(--enki-ember, #c96838)" }} />
                          Council mode
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--enki-ink-2)" }}>
                          Quorum
                          <input type="number" min={1} max={20} value={polQuorum} onChange={(e) => setPolQuorum(e.target.value)} style={{ width: 54, height: 28, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 7px" }} />
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--enki-ink-2)" }}>
                          Expiry (days)
                          <input type="number" min={1} max={30} value={polTtl} onChange={(e) => setPolTtl(e.target.value)} style={{ width: 54, height: 28, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 7px" }} />
                        </label>
                        <Pill kind="green" label="Save policy" onClick={() => void (async () => {
                          const ok = await post({ resource: "policy", action: "set", enabled: polEnabled, quorum: Number(polQuorum), ttlDays: Number(polTtl) }, "Policy saved.", (cur) => cur);
                          if (ok) await reload();
                        })()} />
                      </div>
                      {Number(polQuorum) > c.members.length && (
                        <p style={{ margin: "0 0 8px", fontSize: 11, color: "var(--enki-danger)" }}>
                          Quorum is larger than the council ({c.members.length} member{c.members.length === 1 ? "" : "s"}) — no proposal can pass until more admins exist.
                        </p>
                      )}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {c.members.map((m) => (
                          <span key={m.handle} style={{ display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--enki-rule)", borderRadius: 999, padding: "3px 9px", fontSize: 10.5, fontFamily: MONO, color: "var(--enki-ink-2)" }}>
                            @{m.handle} · {m.role}{m.hasEmail ? " · ✉ ok" : " · no email"}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ))}
            </>
          )}
        </div>
      </div>

      {/* ── whitelist delete confirm (honest — no fake device approval) ── */}
      {delPending && (
        <div onClick={() => setDelPending(null)} style={{ position: "fixed", inset: 0, zIndex: 350, background: "rgba(26,23,21,0.45)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", animation: "adm-fade .15s ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 380, maxWidth: "92vw", background: "var(--enki-paper)", border: "1px solid var(--enki-rule)", borderRadius: 14, padding: "24px 22px", boxShadow: "0 24px 64px rgba(0,0,0,0.3)", animation: "adm-pop .2s ease" }}>
            <div style={{ ...microLabel, fontSize: 8, letterSpacing: "0.18em", marginBottom: 6 }}>Whitelist</div>
            <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 20, fontWeight: 700, color: "var(--enki-ink)", marginBottom: 8 }}>Remove this entry?</div>
            <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "var(--enki-ink-3)", lineHeight: 1.6 }}>
              “{delPending.name}” loses its whitelist access. The entry is deactivated (kept for the audit trail) and disappears from this list.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Pill kind="plain" label="Cancel" onClick={() => setDelPending(null)} />
              <Pill kind="red" label="Remove entry" onClick={() => {
                const f = delPending;
                setDelPending(null);
                void post({ resource: "friends", action: "remove", id: f.id }, "Whitelist entry removed.", (cur) => ({ ...cur, friends: cur.friends.filter((x) => x.id !== f.id) }));
              }} />
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 400, background: "var(--enki-ink)", color: "var(--enki-paper)", fontSize: 12.5, padding: "9px 16px", borderRadius: 999, boxShadow: "0 10px 30px rgba(0,0,0,0.3)", animation: "adm-toast .2s ease", whiteSpace: "nowrap" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
