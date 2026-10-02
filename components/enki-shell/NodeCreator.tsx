"use client";

/* Create Prompt 2 — node-based prompt creator.
   Ported from the design bundle (enki/nodecreator.jsx) and wired to real, free
   Nano Banana Pro generation (Puter.js) + best-effort DB persistence. */

import BoostToggle from "@/components/generation/BoostToggle";
import { apiBoostPricePerImage } from "@/lib/pricing";
import { toModelFamily } from "@/lib/generation/model-family";
import { type Quality } from "@/components/generation/QualitySelect";
import { useModelCatalogue, resolveCatalogueEntry, FALLBACK_RATIOS, tierPrice, tierScale } from "@/hooks/useModelLimits";
import { moveToken } from "@/lib/editor/move-token";
import { TOKEN_SRC, variableRange } from "@/lib/editor/selection-variable";
import RatioRect from "@/components/generation/RatioRect";
import { FREE_TIERS, tiersUpTo, TIER_PRICE_MULT } from "@/lib/generation/resolution";
import { useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Gem } from "lucide-react";
import { Icon } from "./icons";
import { persistCreation, placeholderArt } from "./generation";
import { runGeneration } from "@/lib/generation/run-generation";
import { useModelLimits } from "@/hooks/useModelLimits";
import DocView from "./DocView";
import DiceButton from "@/components/DiceButton";
import WorkflowPicker, { type WorkflowPick } from "./WorkflowPicker";
import { wfToken, resolveWorkflowTokens } from "@/lib/editor/workflow-tokens";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { usePaymentSigner } from "@/hooks/usePaymentSigner";
import type { DiceValue } from "@/lib/generation/variable-dice";

/* ── constants ── */
/* Ratio options come from the SELECTED MODEL's catalogue entry (DB column
   allowed_ratios) — a literal here was why five of Nano Banana Pro's ten
   ratios never showed (Kev, 2026-08-22). "Any" stays first: it means "let
   the server default", which every model supports. */
export const ncRatios = (model?: { ratios: string[] }): string[] => ["Any", ...(model?.ratios ?? FALLBACK_RATIOS)];
const CATEGORIES = ["Portrait", "Character", "Cinematic", "Architecture", "Abstract", "Product", "Minimal", "Editorial"];

const REF_COLOR = { bg: "#E8F8EE", text: "#1F5C38", border: "#1f8a5b", dot: "#1f8a5b" };
// Reference-image chips get their own DISTINCT pastel family (greens/mint) so
// they read differently from text-variable chips at a glance.
const REF_PALETTE = [
  { bg: "#E8F8EE", text: "#1F5C38", border: "#1f8a5b", dot: "#1f8a5b" },
  { bg: "#EDF9E4", text: "#3A5C1F", border: "#6aa832", dot: "#6aa832" },
  { bg: "#E4F6EF", text: "#1F5C4A", border: "#2a9a78", dot: "#2a9a78" },
  { bg: "#F0F9E9", text: "#44551E", border: "#8aa440", dot: "#8aa440" },
];
const TEXT_PALETTE = [
  { bg: "#F3E8FD", text: "#4A2E6E", border: "#8e44ad", dot: "#8e44ad" },
  { bg: "#FDF6E8", text: "#6E4A1E", border: "#c96838", dot: "#c96838" },
  { bg: "#E8F4FD", text: "#1E4A6E", border: "#2a6fdb", dot: "#2a6fdb" },
  { bg: "#FDE8F4", text: "#6E2E5A", border: "#c0398a", dot: "#c0398a" },
  { bg: "#E8F8F8", text: "#1E5C5C", border: "#0e8a8a", dot: "#0e8a8a" },
];
const OUT_PALETTE = [
  { bg: "#FBE9E7", bar: "#e8836b", ink: "#8a3322", soft: "#FDF3F1" },
  { bg: "#E6F2FB", bar: "#5b9bd5", ink: "#1e4a6e", soft: "#F2F8FD" },
  { bg: "#E9F6EC", bar: "#5cb874", ink: "#1f5c38", soft: "#F4FBF6" },
  { bg: "#F4ECFB", bar: "#a06bd0", ink: "#4a2e6e", soft: "#FAF6FD" },
  { bg: "#FCF2E2", bar: "#e0a13a", ink: "#6e4a1e", soft: "#FEF9F0" },
  { bg: "#FBE9F3", bar: "#d56baa", ink: "#6e2e5a", soft: "#FDF3F9" },
];
const VPOOL: Record<string, string[]> = {
  style: ["flowing art-nouveau linework wrapped around organic forms, ornamental yet restrained", "bold baroque chiaroscuro reinterpreted through a modern minimalist lens", "soft watercolor washes bleeding into raw paper, loose and airy", "high-contrast cyberpunk neon, wet reflective surfaces everywhere", "delicate ukiyo-e woodblock flatness with fine outline", "grainy 1970s film still, faded kodachrome palette"],
  mood: ["serene and quietly melancholic, the calm right before rain", "tense and dramatic, heavy with anticipation", "warm, nostalgic golden-hour stillness", "electric, restless, buzzing with night energy", "dreamlike and weightless, softly out of focus"],
  texture: ["hyperreal graphite with fine tooth and soft smudging", "cracked oil-paint impasto catching raking light", "rough cold-press paper grain, visible fibers", "glossy chrome with sharp specular highlights", "matte risograph print with subtle misregistration"],
};
// Built on the same source the shared selection validator uses, so the two
// can never disagree about what a token is.
export const TOKEN_RE = new RegExp("(" + TOKEN_SRC + ")", "g");
export const isRefTok = (t: string) => /^\[Reference Image \d+\]$/.test(t);
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
// Last-used editor view (doc-style vs node canvas) — survives close/reopen.
// Separate key on purpose: the draft's `view` field means pan/zoom, not mode.
const VIEW_KEY = "enki-node-creator-view";
export type EditorView = "doc" | "node";

let NID = 1;
const nid = (p: string) => p + NID++;

export type Kind = "text" | "bool";
export type NodeT = {
  id: string;
  type: "prompt" | "ref" | "text" | "output" | "workflow";
  /* A WORKFLOW node embeds another prompt/workflow (Kev, 2026-09-05): its
     text is read-only IP, its [variables] surface as text nodes owned by it
     (`wfOf`), and {{wf:<id>}} marks its place in the body. `open` = unfolded
     inline so the inside is visible. */
  wf?: { promptId: string | null; title: string; author?: string; price?: number; text: string; vars: string[] };
  open?: boolean;
  wfOf?: string;
  x?: number; y?: number;
  index?: number; img?: string | null; userInput?: boolean;
  name?: string; kind?: Kind; pub?: boolean; value?: string; str?: string;
  sig?: string; vals?: Record<string, string>; status?: "empty" | "loading" | "ready"; picked?: boolean;
  off?: { x: number; y: number };
};
export type Con = { sig: string; body: string; cidx: number; off?: { x: number; y: number } };
export type St = {
  title: string; mode: "free" | "premium"; models: string[]; cat: string; ratio: string; quality: string;
  price: number; body: string; cons: Con[]; conSeq: number; genCount: number; nodes: NodeT[];
};
/**
 * The sizes this prompt's mode can actually produce.
 *
 * A flat ["1K","2K","4K"] here offered 4K to a FREE prompt, whose route is
 * Flux — capped at 0.59 MP, so the 4K entry could only ever return the 2K
 * image under a bigger name, and NC_QUALITY_MULT below charged x2 for it.
 * Premium starts at 2K because the quote and intent schemas do.
 */
export const ncQualities = (mode: St["mode"], maxResolution?: "1K" | "2K" | "4K"): readonly string[] => {
  if (mode === "free") return FREE_TIERS;
  /* Premium: the tiers the SELECTED MODEL genuinely renders, intersected with
     what the paid checkout accepts (2K floor — the quote and intent schemas
     are z.enum(["2K","4K"])). The list used to be hardcoded, so "2K/4K" showed
     for models whose route caps below that; the ceiling now arrives from
     /api/models, resolved by the same code the generation enforces (Kev,
     2026-08-19). No ceiling yet (catalogue still loading) reads as 2K-only —
     the floor — rather than promising 4K on a guess. An empty list means the
     model takes no resolution at all, and the caller hides the control. */
  const cap = maxResolution ?? "2K";
  return tiersUpTo(cap);
};
/* Price multiplier per resolution, relative to the model's base 2K price.
   1K is 1, not 0.5: both hosts charge 1K and 2K identically (Google, 1120
   tokens either way; WaveSpeed nano-banana-pro, $0.14 either way), and the
   server prices a 1K request as the 2K tier (lib/pricing.toResolutionTier).
   Halving it here made the editor's estimate disagree with the real quote. */
export const NC_QUALITY_MULT = TIER_PRICE_MULT;
export type TextNode = NodeT & { name: string; kind: Kind; value: string };

const sigOf = (body: string, texts: TextNode[]) => body + "||" + texts.map((t) => t.name + ":" + t.kind).join(",");
const randVals = (texts: TextNode[]) => {
  const o: Record<string, string> = {};
  texts.forEach((t) => { o["[" + t.name + "]"] = t.kind === "bool" ? (Math.random() > 0.5 ? "on" : "off") : pick(VPOOL[t.name] || VPOOL.style); });
  return o;
};

/* Approximate node footprints (used for tidy row/column placement). */
const NODE_DIM: Record<string, { w: number; h: number }> = {
  prompt: { w: 480, h: 360 }, ref: { w: 172, h: 210 }, text: { w: 260, h: 188 }, output: { w: 208, h: 250 }, workflow: { w: 300, h: 150 },
};

/* build the literal prompt sent to Nano Banana Pro: substitute [var] tokens with
   their values, strip [Reference Image N] tokens (txt2img is text-only). */
function buildPrompt(body: string, texts: TextNode[], valsOverride?: Record<string, string>, workflows: NodeT[] = []) {
  /* Embedded workflows first: each {{wf:id}} becomes the embedded text with
     ITS variables filled from the text nodes it owns, so the host's own
     [variables] below see one flat prompt. */
  const wfVals = (w: NodeT) => {
    const vals: Record<string, string> = {};
    for (const v of w.wf?.vars ?? []) {
      const t = texts.find((x) => x.wfOf === w.id && x.name === v);
      const raw = valsOverride && t ? valsOverride["[" + t.name + "]"] ?? t.value : t?.value;
      vals[v] = t?.kind === "bool" ? (raw === "on" || raw === "Yes" ? ((t.str && t.str.trim()) || v) : "") : (raw ?? "");
    }
    return vals;
  };
  let out = resolveWorkflowTokens(body, workflows.filter((w) => w.type === "workflow" && w.wf).map((w) => ({ id: w.id, text: w.wf!.text, vars: wfVals(w) })));
  texts.forEach((t) => {
    const tok = "[" + t.name + "]";
    const raw = valsOverride ? valsOverride[tok] : t.value;
    let val = "";
    // Checkbox: when ticked, insert its own prompt string (falls back to the name).
    if (t.kind === "bool") val = raw === "on" || raw === "Yes" ? ((t.str && t.str.trim()) || t.name || "") : "";
    else val = raw || "";
    out = out.split(tok).join(val);
  });
  return out.replace(/\[Reference Image \d+\]/g, "").replace(/\s{2,}/g, " ").trim();
}

/* double-click to rename; static span otherwise */
export function EditName({ value, onChange, className, placeholder, title }: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string; title?: string }) {
  const [edit, setEdit] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (edit && ref.current) { ref.current.focus(); ref.current.select(); } }, [edit]);
  if (edit)
    return (
      <input ref={ref} className={className} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} onBlur={() => setEdit(false)}
        onKeyDown={(e) => { if (e.key === "Enter") setEdit(false); }}
        onPointerDown={(e) => e.stopPropagation()} />
    );
  return (
    <span className={className} title={title || "Double-click to rename"} style={{ cursor: "grab", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...(value ? null : { color: "var(--enki-ink-3)", fontStyle: "italic", opacity: 0.8 }) }} onDoubleClick={() => setEdit(true)}>
      {value || placeholder}
    </span>
  );
}

/* Custom themed dropdown (same look + animation as the prompt's model picker),
   reused for every select in the editor so they all match. */
export function NcSelect({ value, options, onChange, width, title, align = "left", icon, grow = true }: {
  value: string; options: { value: string; label: string; sub?: string; icon?: ReactNode }[]; onChange: (v: string) => void;
  width?: number; title?: string; align?: "left" | "right"; icon?: ReactNode;
  /**
   * true (default): `width` is a MINIMUM and the trigger grows for long labels
   * — the truncation fix, right for free-form values like model names.
   * false: `width` is FIXED — right for short bounded enums (ratios, tiers,
   * Low/Mid/High), where growing per selection makes the control jitter as
   * you pick (Kev, 2026-08-19: "NICHT groesser oder kleiner beim auswahl").
   */
  grow?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey, true); };
  }, [open]);
  // Decide flip direction so the panel never spills past the viewport bottom.
  const toggle = () => {
    if (!open) {
      const r = trigRef.current?.getBoundingClientRect();
      const panelH = options.length * 34 + 16;
      if (r) setFlipUp(window.innerHeight - r.bottom < panelH + 14 && r.top > panelH + 14);
    }
    setOpen((o) => !o);
  };
  const cur = options.find((o) => o.value === value);
  return (
    /* minWidth, not width. A hard pixel box plus the ellipsis on .nc-pm-name
       meant any label longer than its box was silently cut — "abgeschnitten
       und nicht vollständig lesbar" (Kev). As a minimum it still lines the
       controls up at their common size and simply grows for the values that
       need it.

       FIXED mode does not pin an guessed number either: `width` is a minimum
       and a hidden sizer holding EVERY option decides the real width. So the
       control is as wide as its longest label — constant no matter which one
       is selected, and never cutting the text. Pinning a literal produced
       "Hi…" for "High" once the gem icon took its space (Kev, 2026-08-19);
       a label that has to be guessed at is not a label. */
    <div className={"nc-sel" + (align === "right" ? " nc-sel--r" : "") + (flipUp ? " nc-sel--up" : "") + (grow ? "" : " nc-sel--fixed")} ref={ref} style={width ? { minWidth: width } : undefined} onPointerDown={(e) => e.stopPropagation()}>
      <button ref={trigRef} className={"nc-pm-trigger" + (open ? " open" : "")} title={title ? `${title} — ${cur ? cur.label : value}` : (cur ? cur.label : value)} onClick={(e) => { e.stopPropagation(); toggle(); }}>
        {icon && <span className="nc-pm-ico">{icon}</span>}
        <span className="nc-pm-name">
          {cur ? cur.label : value}
          {/* Zero-height, invisible, and still contributing its intrinsic
              width: this is what makes the trigger fit the longest option
              without measuring anything at runtime. */}
          {!grow && (
            <span className="nc-pm-sizer" aria-hidden>
              {options.map((o) => <span key={o.value}>{o.label}</span>)}
            </span>
          )}
        </span>
        {cur?.sub && <span className="nc-pm-price">{cur.sub}</span>}
        <Icon name="chevronDown" size={13} stroke={2.4} className="nc-pm-chev" />
      </button>
      {open && (
        <div className="nc-pm-panel" role="listbox">
          {options.map((o) => (
            <button key={o.value} role="option" aria-selected={o.value === value} className={"nc-pm-opt" + (o.value === value ? " on" : "")} onClick={() => { onChange(o.value); setOpen(false); }}>
              {o.icon && <span className="nc-pm-opt-ico">{o.icon}</span>}
              <span className="nc-pm-opt-name">{o.label}</span>
              {o.sub && <span className="nc-pm-opt-cost">{o.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface NodeCreatorProps {
  onClose: () => void;
  onToast: (msg: string) => void;
  userKey?: string | null;
  sidebarW?: number;
  editPrompt?: unknown;
}

export default function NodeCreator({ onClose, onToast, userKey, sidebarW = 78, editPrompt }: NodeCreatorProps) {
  const sidebarWRef = useRef(sidebarW); sidebarWRef.current = sidebarW;
  // Prompt-box height, sized so the whole node fits between the top ribbon and the bottom.
  const boxH = useRef(0);
  if (!boxH.current) boxH.current = typeof window !== "undefined" ? Math.round(Math.min(400, Math.max(220, window.innerHeight - 420))) : 340;
  // Start with just the prompt box — the user adds references / text inputs and
  // generates; constellation rows then form automatically as outputs appear.
  const initial = (): St => {
    const h = typeof window !== "undefined" ? window.innerHeight : 800;
    const w = typeof window !== "undefined" ? window.innerWidth - sidebarW : 1100;
    const TOPBAR = 64, BOTTOM = 16;
    const nodeH = boxH.current + 240; // header + refs deck + add-row + note + paddings
    const dockLeft = w - 224;
    // Centre the node between the left-menu edge and the Generate dock, fully below the ribbon.
    const x = Math.max(40, Math.round(dockLeft / 2 - 240));
    const y = Math.max(TOPBAR, Math.round(TOPBAR + (h - TOPBAR - BOTTOM - nodeH) / 2));
    const nodes: NodeT[] = [{ id: "prompt", type: "prompt", x, y }];

    // Editing an existing released prompt → rebuild its node graph.
    const ep = editPrompt as { title?: string; promptTemplate?: string; price?: number; derivedFrom?: string; variables?: Array<{ name?: string; type?: string; value?: unknown }> } | null;
    if (ep && (ep.promptTemplate || ep.title)) {
      const vars = Array.isArray(ep.variables) ? ep.variables : [];
      let ti = 0;
      vars.forEach((v) => {
        if (v.type === "image") {
          // reference images go into the prompt's in-built deck (no canvas node)
          nodes.push({ id: nid("r"), type: "ref", img: typeof v.value === "string" ? v.value : null, userInput: false });
        } else {
          const kind: Kind = v.type === "checkbox" ? "bool" : "text";
          nodes.push({ id: nid("t"), type: "text", x: x - 288, y: y + ti * 254, name: String(v.name || "var_" + (ti + 1)), kind, pub: true, value: kind === "bool" ? (v.value ? "on" : "off") : String(v.value ?? "") });
          ti += 1;
        }
      });
      return {
        title: String(ep.title || ""), mode: (ep.price ?? 0) > 0 ? "premium" : "free",
        models: [], cat: "", ratio: "Any", quality: "2K",
        price: typeof ep.price === "number" ? ep.price : 0.1,
        body: String(ep.promptTemplate || ""),
        cons: [], conSeq: 0, genCount: 4, nodes,
      };
    }

    return {
      title: "", mode: "premium", models: [], cat: "", ratio: "Any", quality: "2K",
      price: 0.1, body: "", cons: [], conSeq: 0, genCount: 4, nodes,
    };
  };

  const [st, setSt] = useState<St>(initial);
  const stRef = useRef(st); stRef.current = st;
  // Doc-style vs node-canvas view. Doc is the default for new sessions; the
  // last-used view survives close/reopen (Kev's "resume where I left off").
  const [view, setView] = useState<EditorView>(() => {
    try { const v = localStorage.getItem(VIEW_KEY); if (v === "node" || v === "doc") return v; } catch { /* noop */ }
    return "doc";
  });
  const viewRef = useRef(view); viewRef.current = view;
  /* Doc view animates in (.ncd carries nc-pm-in); the canvas is mounted
     UNDERNEATH it the whole time, so switching back merely removed the
     overlay and the nodes just popped (Kev, 2026-08-19). The same entry
     plays on the canvas when it becomes the visible view. */
  const [canvasIn, setCanvasIn] = useState(false);
  const switchView = (v: EditorView) => {
    if (v === "node") setCanvasIn(true);
    if (v === viewRef.current) return;
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* noop */ }
    if (v === "doc") {
      // Leaving the canvas: drop canvas-only interaction state so stale
      // selections can't eat Delete keys or ESC while the doc is up.
      setSel(null); setSelRow(null); setSelSet(new Set());
      setCtx(null); setMarquee(null); setTokEdit(null); setMenuOpen(false); setModelOpen(false);
    }
  };
  // Per-model limits (max reference images, allowed filetypes) from the DB.
  const modelLimits = useModelLimits(st.models[0]);
  const hist = useRef<{ past: St[]; future: St[] }>({ past: [], future: [] });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1); zoomRef.current = zoom;
  const panRef = useRef(pan); panRef.current = pan;
  const zoomAnim = useRef<number | null>(null);
  const [zoomEditing, setZoomEditing] = useState(false);
  const [zoomInput, setZoomInput] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [selRow, setSelRow] = useState<string | null>(null);
  const selRef = useRef<string | null>(null); selRef.current = sel;
  const selRowRef = useRef<string | null>(null); selRowRef.current = selRow;
  const [selSet, setSelSet] = useState<Set<string>>(new Set());
  const selSetRef = useRef<Set<string>>(new Set()); selSetRef.current = selSet;
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const spaceRef = useRef(false);
  const [armed, setArmed] = useState<string | null>(null);
  // In-place variable editor: clicking a [token] chip in the prompt opens a
  // small popover right beside it (left when space allows) with that
  // variable's value — no hunting for the input node on the canvas.
  const [tokEdit, setTokEdit] = useState<{ name: string; rect: { left: number; right: number; top: number; bottom: number } } | null>(null);
  const tokEditRef = useRef(false); tokEditRef.current = !!tokEdit;
  const [ctx, setCtx] = useState<{ x: number; y: number; wx: number; wy: number } | null>(null);
  const [dropOn, setDropOn] = useState(false);
  const [pulseId, setPulseId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false); // top-right burger menu
  const fileRef = useRef<HTMLInputElement>(null);   // hidden picker for JSON import
  const refUploadRef = useRef<HTMLInputElement>(null); // hidden picker for multi reference upload
  // mock-up mode: Generate fills outputs with instant placeholder art (no API)
  // so the whole flow — groups, lightbox, release — can be demoed offline.
  // The generator list, from the database. Nothing is preselected: the user
  // picks (Kev, 2026-10-02: "IMMER DAS AUSGEWÄHLTE").
  const catalogue = useModelCatalogue();
  /* Which way the price is rolling, for the step animation; cleared by
     onAnimationEnd so a held click can re-trigger. */
  const [priceRoll, setPriceRoll] = useState<"up" | "down" | null>(null);
  /* The value BEFORE the step, so the digit view knows which digits changed
     — only those roll. */
  const prevPriceRef = useRef(0);
  const [priceEdit, setPriceEdit] = useState(false);
  // Refs, because finalizeOutput is a useCallback: reading these from the
  // render scope would pin it to whatever the catalogue was on first paint.
  const signPayment = usePaymentSigner();
  const catalogueRef = useRef(catalogue);
  catalogueRef.current = catalogue;
  const [mockMode, setMockMode] = useState(false);
  // Same model on a priority host — faster, dearer, identical image.
  const [boost, setBoost] = useState(false);
  const boostRef = useRef(boost);
  boostRef.current = boost;
  // Only gpt-image takes this; the control hides itself for everything else.
  const [quality, setQuality] = useState<Quality>("medium");
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  /* By id OR by family slug: drafts store "nano-banana-pro" while the DB
     keys models by UUID, and an exact-id find missed for every draft that
     never re-picked its model — hiding the gpt lever and zeroing the cost
     line. */
  const selectedModel = resolveCatalogueEntry(catalogue, st.models[0]);
  const supportsQuality = selectedModel?.supportsQuality ?? false;
  const qualityTiers = ncQualities(st.mode, selectedModel?.maxResolution);
  const mockModeRef = useRef(false); mockModeRef.current = mockMode;
  // canvas tool: "select" (left = marquee, right = pan) or "hand" (left = pan)
  const [tool, setTool] = useState<"select" | "hand">("select");
  // `panning` is state (not just the drag ref) so releasing the mouse re-renders and
  // the grabbing-hand cursor reverts to the pointer immediately.
  const [panning, setPanning] = useState(false);
  const [modelOpen, setModelOpen] = useState(false); // per-prompt model dropdown
  const [modelFlipUp, setModelFlipUp] = useState(false);
  const modelTrigRef = useRef<HTMLButtonElement>(null);
  const [genPanelOpen, setGenPanelOpen] = useState(true); // toolbar Generate panel (open by default)
  // image lightbox: maximize an output, browse its group + switch between groups
  const [lbOpen, setLbOpen] = useState(false);
  const [lbG, setLbG] = useState(0);   // group (constellation row) index
  const [lbI, setLbI] = useState(0);   // image index within the group
  const lbOpenRef = useRef(false); lbOpenRef.current = lbOpen;
  const [refMax, setRefMax] = useState<string | null>(null); // maximized reference image
  const deckRef = useRef<HTMLDivElement>(null);               // referenced-images deck (for overlap fit)
  const [deckW, setDeckW] = useState(440);
  const [refDragI, setRefDragI] = useState<number | null>(null); // card being dragged
  const [refInsI, setRefInsI] = useState<number | null>(null); // insertion SLOT (0..refs.length, original order); null = no move
  useEffect(() => {
    const el = deckRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setDeckW(el.clientWidth));
    ro.observe(el); setDeckW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const [expandedOuts, setExpandedOuts] = useState<Record<string, boolean>>({});
  const toggleExpand = (id: string) => setExpandedOuts((m) => ({ ...m, [id]: !m[id] }));
  const [outEdit, setOutEdit] = useState<string | null>(null);
  const [confirmPush, setConfirmPush] = useState<string | null>(null);
  const [dock, setDock] = useState({ x: 0, y: 0, placed: false });
  const dockTopRef = useRef(80);
  const [tipOpen, setTipOpen] = useState(true);
  const [dockSide, setDockSide] = useState<"left" | "right" | null>(null);
  const pendingDockSide = useRef<"left" | "right" | null>(null);
  const [connectLine, setConnectLine] = useState<{ from: { x: number; y: number }; to: { x: number; y: number }; color: string } | null>(null);
  // Prompt box height — roughly doubled but capped so the node never spills past the frame.
  const canvasRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const ovRef = useRef<HTMLDivElement>(null);

  const pushHist = () => { hist.current.past.push(stRef.current); if (hist.current.past.length > 60) hist.current.past.shift(); hist.current.future = []; };
  const commit = (updater: (p: St) => St) => { pushHist(); setSt(updater); };
  const undo = () => { if (!hist.current.past.length) return; hist.current.future.push(stRef.current); setSt(hist.current.past.pop()!); };
  const redo = () => { if (!hist.current.future.length) return; hist.current.past.push(stRef.current); setSt(hist.current.future.pop()!); };

  /* ── JSON export / import (ComfyUI-style node graph) ──
     ComfyUI serialises a workflow as a flat `nodes[]` array — each node carries
     an id, a `type`, a `pos:[x,y]`, and its widget values — plus top-level
     graph metadata. We mirror that shape so the file reads like a Comfy graph,
     while keeping every Enki-specific field needed for a lossless round-trip. */
  const NTYPE_OUT: Record<NodeT["type"], string> = { prompt: "EnkiPrompt", ref: "EnkiReferenceImage", text: "EnkiTextInput", output: "EnkiOutputImage", workflow: "EnkiWorkflow" };
  const NTYPE_IN: Record<string, NodeT["type"]> = { EnkiPrompt: "prompt", EnkiReferenceImage: "ref", EnkiTextInput: "text", EnkiOutputImage: "output", EnkiWorkflow: "workflow" };
  const buildExportJSON = () => {
    const s = stRef.current;
    const nodes = s.nodes.map((n) => {
      const out: Record<string, unknown> = { id: n.id, type: NTYPE_OUT[n.type] || n.type };
      out.pos = (typeof n.x === "number" && typeof n.y === "number") ? [n.x, n.y] : null;
      if (n.off) out.off = n.off;
      if (n.img != null) out.image = n.img;
      if (n.userInput != null) out.userInput = n.userInput;
      if (n.name != null) out.name = n.name;
      if (n.kind != null) out.kind = n.kind;
      if (n.value != null) out.value = n.value;
      if (n.str != null) out.str = n.str;
      if (n.pub != null) out.pub = n.pub;
      if (n.picked != null) out.picked = n.picked;
      if (n.sig != null) out.sig = n.sig;
      if (n.status != null) out.status = n.status;
      if (n.wf) out.wf = n.wf;
      if (n.open != null) out.open = n.open;
      if (n.wfOf) out.wfOf = n.wfOf;
      if (n.index != null) out.index = n.index;
      if (n.vals != null) out.widgets_values = n.vals;
      return out;
    });
    return {
      format: "enki-prompt-graph", version: 1, comfy_version: 0.4,
      title: s.title,
      settings: { mode: s.mode, models: s.models, category: s.cat, ratio: s.ratio, quality: s.quality, price: s.price, genCount: s.genCount },
      prompt: s.body,
      nodes,
      constellations: s.cons || [], conSeq: s.conSeq || 0,
      view: { pan: panRef.current, zoom: zoomRef.current },
    };
  };
  const exportPrompt = () => {
    setMenuOpen(false);
    try {
      const data = buildExportJSON();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safe = (stRef.current.title || "untitled-prompt").replace(/[^a-z0-9\-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "prompt";
      a.href = url; a.download = `${safe}.enki.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      onToast("Prompt exported as JSON");
    } catch { onToast("Couldn't export this prompt"); }
  };
  const applyImportJSON = (raw: unknown, silent = false) => {
    const data = raw as { format?: string; title?: string; prompt?: string; nodes?: unknown[]; settings?: Record<string, unknown>; constellations?: unknown[]; conSeq?: number; view?: { pan?: { x: number; y: number }; zoom?: number } };
    if (!data || data.format !== "enki-prompt-graph" || !Array.isArray(data.nodes)) { if (!silent) onToast("Not a valid Enki prompt JSON file"); return; }
    const nodes: NodeT[] = data.nodes.map((raw2) => {
      const o = raw2 as Record<string, unknown>;
      const n: NodeT = { id: String(o.id), type: NTYPE_IN[String(o.type)] || (o.type as NodeT["type"]) };
      if (Array.isArray(o.pos)) { n.x = Number(o.pos[0]); n.y = Number(o.pos[1]); }
      if (o.off) n.off = o.off as NodeT["off"];
      if (o.image != null) n.img = o.image as string;
      if (o.userInput != null) n.userInput = !!o.userInput;
      if (o.name != null) n.name = String(o.name);
      if (o.kind != null) n.kind = o.kind as Kind;
      if (o.value != null) n.value = String(o.value);
      if (o.str != null) n.str = String(o.str);
      if (o.pub != null) n.pub = !!o.pub;
      if (o.picked != null) n.picked = !!o.picked;
      if (o.sig != null) n.sig = String(o.sig);
      if (o.status != null) n.status = o.status as NodeT["status"];
      if (o.wf && typeof o.wf === "object") n.wf = o.wf as NodeT["wf"];
      if (o.open != null) n.open = !!o.open;
      if (typeof o.wfOf === "string") n.wfOf = o.wfOf;
      if (o.index != null) n.index = Number(o.index);
      if (o.widgets_values != null) n.vals = o.widgets_values as Record<string, string>;
      return n;
    });
    if (!nodes.some((n) => n.type === "prompt")) { if (!silent) onToast("That JSON has no prompt node — can't import"); return; }
    const s = data.settings || {};
    if (!silent) pushHist();
    setSt((p) => ({
      ...p,
      title: typeof data.title === "string" ? data.title : "",
      mode: s.mode === "free" ? "free" : "premium",
      models: Array.isArray(s.models) ? (s.models as string[]) : [],
      cat: typeof s.category === "string" ? s.category : "",
      ratio: typeof s.ratio === "string" ? s.ratio : "Any",
      quality: typeof s.quality === "string" ? s.quality : "2K",
      price: typeof s.price === "number" ? s.price : 0.1,
      genCount: typeof s.genCount === "number" ? s.genCount : 4,
      body: typeof data.prompt === "string" ? data.prompt : "",
      cons: Array.isArray(data.constellations) ? (data.constellations as Con[]) : [],
      conSeq: typeof data.conSeq === "number" ? data.conSeq : 0,
      nodes,
    }));
    // Keep new-node ids from colliding with imported ones.
    let maxN = NID;
    nodes.forEach((n) => { const m = /(\d+)$/.exec(n.id || ""); if (m) maxN = Math.max(maxN, parseInt(m[1], 10) + 1); });
    NID = maxN;
    if (data.view) { if (data.view.pan) setPan(data.view.pan); if (typeof data.view.zoom === "number") setZoom(Math.min(1, Math.max(0.3, data.view.zoom))); }
    if (!silent) onToast("Prompt imported from JSON");
  };

  /* ── Browser draft + ESC close flow ──
     ESC on a neutral canvas (nothing mid-drag/open) asks save-or-discard when
     there's content. Save keeps the whole graph in localStorage and it's
     restored the next time Create Prompt 2 opens fresh. */
  const DRAFT_KEY = "enki-node-creator-draft";
  const [closeConfirm, setCloseConfirm] = useState(false);
  const closeConfirmRef = useRef(false); closeConfirmRef.current = closeConfirm;
  const isDirty = () => {
    const s = stRef.current;
    return !!(s.title.trim() || s.body.trim() || (s.cons?.length ?? 0) > 0 || s.nodes.length > 1);
  };
  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* noop */ } };
  const requestClose = () => {
    if (!isDirty()) { clearDraft(); onClose(); return; }
    setCloseConfirm(true);
  };
  /* ── Workflow nodes (Kev, 2026-09-05) ── */
  const [wfPickerOpen, setWfPickerOpen] = useState(false);
  const addWorkflow = (pick: WorkflowPick) => {
    setWfPickerOpen(false);
    pushHist();
    setSt((p) => {
      const base = p.nodes.find((n) => n.id === "prompt");
      const id = nid("w");
      const existing = p.nodes.filter((n) => n.type === "workflow").length;
      const dim = NODE_DIM.workflow;
      const node: NodeT = {
        id, type: "workflow", open: false,
        x: (base?.x || 0) - dim.w - 80, y: (base?.y || 0) + 420 + existing * (dim.h + 18),
        wf: { promptId: pick.promptId, title: pick.title, author: pick.author, text: pick.text, vars: pick.vars },
      };
      // Its inputs become text nodes it owns — fill and wire them like your own.
      const tdim = NODE_DIM.text;
      const inputs: NodeT[] = pick.vars.map((v, i) => ({
        id: nid("t"), type: "text", kind: "text", pub: true, value: "", name: v, wfOf: id,
        x: (node.x || 0) - tdim.w - 60, y: (node.y || 0) + i * (tdim.h + 14),
      }));
      const body = (p.body.trimEnd() + " " + wfToken(id)).trim();
      return { ...p, body, nodes: [...p.nodes, node, ...inputs] };
    });
    onToast("Workflow inserted. Its inputs are the new text nodes; the {{wf}} marker in the prompt is where it speaks.");
  };
  const toggleWorkflowOpen = (id: string) => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, open: !n.open } : n)) }));
  const [libSaving, setLibSaving] = useState(false);
  const saveToLibrary = async () => {
    setMenuOpen(false);
    if (libSaving) return;
    const name = (stRef.current.title || "").trim() || "Untitled workflow";
    setLibSaving(true);
    try {
      const res = await fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ name, kind: "workflow", graph: buildExportJSON(), promptText: stRef.current.body }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      onToast(res.ok ? `Saved "${name}" to your library` : body.error || "Couldn't save. Are you logged in?");
    } catch { onToast("Couldn't save to your library"); }
    finally { setLibSaving(false); }
  };

  const saveDraftAndClose = () => {
    // Quota failures must NOT close the editor while claiming success — with
    // data-URL reference images a draft easily exceeds the ~5MB localStorage cap.
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(buildExportJSON()));
    } catch {
      setCloseConfirm(false);
      onToast("Draft too big to save (images count against a ~5MB cap) — export as JSON via the menu, or remove some images.");
      return;
    }
    setCloseConfirm(false);
    onToast("Draft saved — it'll be restored when you come back");
    onClose();
  };
  const discardAndClose = () => { clearDraft(); setCloseConfirm(false); onClose(); };

  // Restore a saved draft when opening fresh (not when editing a released prompt).
  useEffect(() => {
    /* Opened from the profile's Library: the saved graph IS the editor
       state — restore it as-is instead of rebuilding from fields. */
    const libGraph = (editPrompt as { libraryGraph?: unknown } | null)?.libraryGraph;
    if (libGraph) { applyImportJSON(libGraph, true); return; }
    if (editPrompt) return;
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      applyImportJSON(JSON.parse(raw), true);
      onToast("Restored your saved draft");
    } catch { clearDraft(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const importPrompt = () => { setMenuOpen(false); fileRef.current?.click(); };
  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { try { applyImportJSON(JSON.parse(String(reader.result))); } catch { onToast("Couldn't read that JSON file"); } };
    reader.readAsText(f);
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The in-place variable editor is open → ESC just closes it.
        if (tokEditRef.current) { setTokEdit(null); return; }
        // The save/discard dialog is open → ESC just dismisses it (keep editing).
        if (closeConfirmRef.current) { setCloseConfirm(false); return; }
        // The "+ Variable" pill is up → ESC only dismisses the pill. Without
        // this, ESC fell through to the editor's close/save-discard flow
        // (found by review, 2026-08-22).
        if (selPillRef.current) { setSelPill(null); return; }
        // Something in progress (drag / connect / marquee / menu / selection)?
        // → ESC cancels it and returns the canvas to a neutral state.
        const busy = !!drag.current || rightPan.current.active || escBusyRef.current
          || !!ctx || !!selRef.current || !!selRowRef.current || selSetRef.current.size > 0;
        if (busy) {
          if (drag.current) {
            drag.current = null;
            document.body.style.userSelect = "";
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", endDrag);
            window.removeEventListener("pointercancel", endDrag);
          }
          rightPan.current.active = false;
          setConnectLine(null);
          setMarquee(null);
          setMenuOpen(false);
          setModelOpen(false);
          setGenPanelOpen(false);
          setRefMax(null);
          setGenConfirm(null);
          if (ctx) setCtx(null);
          setSel(null); setSelRow(null); setSelSet(new Set());
          return;
        }
        // Neutral canvas → leave. Asks save-or-discard when there's content.
        requestClose();
        return;
      }
      const meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (meta && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (viewRef.current !== "node") return; // canvas-only shortcut
        const ae = document.activeElement as HTMLElement | null;
        // don't hijack deletes while typing in a field (token-delete etc.)
        if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
        if (selSetRef.current.size) { e.preventDefault(); selSetRef.current.forEach((id) => deleteNodeId(id)); setSelSet(new Set()); }
        else if (selRef.current) { e.preventDefault(); deleteNodeId(selRef.current); setSel(null); }
        else if (selRowRef.current) { e.preventDefault(); deleteRow(selRowRef.current); setSelRow(null); }
      }
    };
    const onSpace = (e: KeyboardEvent) => { if (e.code === "Space") { if (viewRef.current !== "node") return; const ae = document.activeElement as HTMLElement | null; if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return; spaceRef.current = e.type === "keydown"; } };
    window.addEventListener("keydown", k);
    window.addEventListener("keydown", onSpace);
    window.addEventListener("keyup", onSpace);
    return () => { window.removeEventListener("keydown", k); window.removeEventListener("keydown", onSpace); window.removeEventListener("keyup", onSpace); };
  }, [onClose, ctx]);
  useEffect(() => () => { if (zoomAnim.current) clearTimeout(zoomAnim.current); if (panAnim.current) clearTimeout(panAnim.current); }, []);
  // lock page scroll while the editor is open so the frame (and the flush-right
  // Generate panel) sit at the true window edge with no scrollbar gap.
  useEffect(() => {
    const root = document.documentElement;
    const prevBody = document.body.style.overflow;
    const prevRoot = root.style.overflow;
    const prevGutter = root.style.scrollbarGutter;
    document.body.style.overflow = "hidden";
    root.style.overflow = "hidden";
    // html{scrollbar-gutter:stable} keeps a ~15px gutter even with overflow hidden,
    // which would push the flush-right Generate panel off the window edge. Drop it
    // while the editor owns the viewport so the frame fills the full width.
    root.style.scrollbarGutter = "auto";
    return () => {
      document.body.style.overflow = prevBody;
      root.style.overflow = prevRoot;
      root.style.scrollbarGutter = prevGutter;
    };
  }, []);
  // Close the model dropdown on any click outside it.
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest(".nc-pm")) setModelOpen(false); };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [modelOpen]);

  /* cursor-anchored wheel zoom (max = 1) */
  useEffect(() => {
    const el = canvasRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (viewRef.current !== "node") return; // doc view scrolls normally
      e.preventDefault();
      const z = zoomRef.current, p = panRef.current;
      // Continuous, cursor-anchored zoom — magnitude follows the scroll delta
      // (normalised across mouse "line" and trackpad "pixel" modes) for a
      // smooth, non-jumpy feel.
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-e.deltaY * unit * 0.0042);
      const nz = Math.max(0.3, Math.min(1, z * factor));
      if (nz === z) return;
      const mx = e.clientX - sidebarWRef.current, my = e.clientY;
      const wx = (mx - p.x) / z, wy = (my - p.y) / z;
      setPan({ x: mx - wx * nz, y: my - wy * nz }); setZoom(nz);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /* While the editor is open, unconsumed HORIZONTAL wheel deltas anywhere on
     the page (sidebar, toolbar, prompt column — not just the canvas) feed the
     browser's back/forward swipe gesture: a node drag with a second finger on
     the trackpad moved for a moment, then the "go back" bubble appeared.
     overscroll-behavior alone didn't stop it, so the deltas are consumed here. */
  useEffect(() => {
    const stopNavSwipe = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      // Doc view: only the results strips legitimately scroll horizontally —
      // everywhere else the delta would feed the browser's back/forward swipe
      // and nuke unsaved work.
      if (viewRef.current !== "node") {
        const t = e.target as HTMLElement | null;
        if (t && typeof t.closest === "function" && t.closest(".ncd-strip")) return;
      }
      e.preventDefault();
    };
    window.addEventListener("wheel", stopNavSwipe, { passive: false });
    return () => window.removeEventListener("wheel", stopNavSwipe);
  }, []);
  // Smooth, animated zoom toward a target level (cursor/center-anchored). The
  // % readout follows the animation frame-by-frame, so it ramps up/down too.
  const tweenZoom = (target: number) => {
    const z0 = zoomRef.current;
    const z1 = Math.max(0.3, Math.min(1, target));
    if (Math.abs(z1 - z0) < 0.001) return;
    const mx = (window.innerWidth - sidebarWRef.current) / 2, my = window.innerHeight / 2;
    const p0 = panRef.current;
    const wx = (mx - p0.x) / z0, wy = (my - p0.y) / z0;
    if (zoomAnim.current) clearTimeout(zoomAnim.current);
    // Fixed-step tween (clock-independent so it always terminates and stays smooth).
    const STEPS = 14; let i = 0;
    const step = () => {
      i += 1;
      const t = i / STEPS;
      const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const zt = z0 + (z1 - z0) * e;
      setZoom(zt);
      setPan({ x: mx - wx * zt, y: my - wy * zt });
      zoomAnim.current = i < STEPS ? (window.setTimeout(step, 16) as unknown as number) : null;
    };
    step();
  };
  const commitZoomInput = () => {
    const v = parseFloat(zoomInput);
    setZoomEditing(false);
    if (!Number.isNaN(v)) tweenZoom(v / 100);
  };
  // Smooth pan tween (fixed-step easeOutCubic) used by the edge-arrow focus jump.
  const panAnim = useRef<number | null>(null);
  const tweenPan = (tx: number, ty: number) => {
    const p0 = panRef.current;
    if (Math.abs(tx - p0.x) < 1 && Math.abs(ty - p0.y) < 1) return;
    if (panAnim.current) clearTimeout(panAnim.current);
    const STEPS = 16; let i = 0;
    const step = () => {
      i += 1; const t = i / STEPS; const e = 1 - Math.pow(1 - t, 3);
      setPan({ x: p0.x + (tx - p0.x) * e, y: p0.y + (ty - p0.y) * e });
      panAnim.current = i < STEPS ? (window.setTimeout(step, 16) as unknown as number) : null;
    };
    step();
  };
  const focusFrame = (fx: number, fw: number, fy: number) => {
    const z = zoomRef.current;
    const cx = (window.innerWidth - sidebarWRef.current) / 2, cy = window.innerHeight / 2;
    const wcx = fx + fw / 2, wcy = fy + 150;
    tweenPan(cx - wcx * z, cy - wcy * z);
  };
  // Track viewport so the off-screen edge arrows reposition on resize.
  const [vp, setVp] = useState({ w: typeof window !== "undefined" ? window.innerWidth : 1280, h: typeof window !== "undefined" ? window.innerHeight : 800 });
  useEffect(() => {
    const onR = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, []);

  const prompt = st.nodes.find((n) => n.id === "prompt")!;
  const refs = st.nodes.filter((n) => n.type === "ref");
  // Card-deck overlap: advance per card so all refs fit the deck width (reserving
  // the "+"). Few cards → full gap (no overlap); many → they slide under each other.
  const REF_CARD = 62, REF_GAP = 7;
  const refStep = refs.length <= 1 ? REF_CARD + REF_GAP
    : Math.min(REF_CARD + REF_GAP, Math.max(15, (Math.max(REF_CARD, deckW - (REF_CARD + REF_GAP)) - REF_CARD) / (refs.length - 1)));
  const refOverlap = Math.round(refStep - REF_CARD); // marginLeft for cards after the first (negative = overlap)
  const texts = st.nodes.filter((n) => n.type === "text") as TextNode[];
  const pubNames = new Set(texts.filter((t) => t.pub).map((t) => t.name)); // user-input vars → turquoise
  // Chips render ONLY for tokens with a live backing node (text var by name,
  // ref by index); orphaned tokens fall back to plain [bracketed] text.
  const liveTokNames = new Set(texts.map((t) => t.name));
  const liveRefCount = st.nodes.filter((n) => n.type === "ref").length;
  const outs = st.nodes.filter((n) => n.type === "output");
  // Can only generate once there's an actual prompt and every text var has a value.
  // Only a prompt is required to generate — unfilled variables just resolve to empty.
  const canGenerate = st.body.trim().length > 0 && !!selectedModel;

  const curSig = sigOf(st.body, texts);
  const layout = useMemo(() => {
    // First group sits to the RIGHT of the prompt at the same height; every
    // further group stacks below it.
    const OX = (prompt.x || 0) + 560, ROWH = 326, COLW = 196, TOP = (prompt.y || 0);
    const map: Record<string, { x: number; y: number }> = {};
    const frames: { sig: string; cidx: number; body: string; ri: number; x: number; y: number; w: number; count: number; current: boolean }[] = [];
    const seen = (st.cons || []).map((c) => c.sig);
    const order = seen.includes(curSig) ? st.cons.slice() : [{ sig: curSig, body: st.body, cidx: st.conSeq || 0 }, ...(st.cons || [])];
    order.forEach((con, ri) => {
      const rowOuts = outs.filter((o) => o.sig === con.sig);
      const off = con.off || { x: 0, y: 0 };
      // Row is keyed off the group's STABLE cidx (assigned once at creation),
      // not its position in the order array — so spawning/removing other groups
      // never shifts an already-placed group. It only moves when the user drags
      // its row handle (the `off` offset).
      const fx = OX + off.x, y = TOP + (con.cidx || 0) * ROWH + off.y;
      rowOuts.forEach((o, ci) => { map[o.id] = { x: fx + 18 + ci * COLW, y: y + 34 }; });
      frames.push({ sig: con.sig, cidx: con.cidx, body: con.body, ri, x: fx, y, w: Math.max(1, rowOuts.length) * COLW + 30, count: rowOuts.length, current: con.sig === curSig });
    });
    return { map, frames, OX, ROWH, COLW, TOP };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.cons, st.nodes, st.body, prompt.x, prompt.y, curSig]);
  const palOf = (cidx: number) => OUT_PALETTE[((cidx % OUT_PALETTE.length) + OUT_PALETTE.length) % OUT_PALETTE.length];

  // Lightbox groups: every constellation row that has rendered images, in the
  // same top-to-bottom order as the canvas. Each group keeps its colour + body.
  const lbGroups = useMemo(() => {
    const imgOuts = outs.filter((o) => o.img);
    return layout.frames
      .map((f) => ({ sig: f.sig, cidx: f.cidx, body: f.body, imgs: imgOuts.filter((o) => o.sig === f.sig) }))
      .filter((g) => g.imgs.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.frames, st.nodes]);

  const openLightbox = (id: string) => {
    const target = stRef.current.nodes.find((n) => n.id === id);
    if (!target || !target.img) return;
    const imgOuts = stRef.current.nodes.filter((n) => n.type === "output" && n.img);
    const order = layout.frames.map((f) => f.sig);
    const gi = order.findIndex((sig) => sig === target.sig && imgOuts.some((o) => o.sig === sig));
    const gIdx = gi >= 0 ? layout.frames.slice(0, gi).filter((f) => imgOuts.some((o) => o.sig === f.sig)).length : 0;
    const groupImgs = imgOuts.filter((o) => o.sig === target.sig);
    const iIdx = Math.max(0, groupImgs.findIndex((o) => o.id === id));
    setLbG(gIdx); setLbI(iIdx); setLbOpen(true);
  };
  const lbGroupsRef = useRef(lbGroups); lbGroupsRef.current = lbGroups;
  // ↑/↓ switch image group · ←/→ switch image within the group · Esc closes.
  // Capture phase so these keys never fall through to the canvas shortcuts.
  useEffect(() => {
    if (!lbOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const groups = lbGroupsRef.current;
      if (!groups.length) { if (e.key === "Escape") { e.stopPropagation(); setLbOpen(false); } return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setLbOpen(false); }
      else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); setLbG((g) => Math.min(groups.length - 1, g + 1)); setLbI(0); }
      else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); setLbG((g) => Math.max(0, g - 1)); setLbI(0); }
      else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); setLbI((i) => { const g = Math.min(lbGRef.current, groups.length - 1); const n = groups[g].imgs.length; return Math.min(n - 1, i + 1); }); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); setLbI((i) => Math.max(0, i - 1)); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [lbOpen]);
  const lbGRef = useRef(lbG); lbGRef.current = lbG;

  const textColor = useMemo(() => {
    const m: Record<string, typeof TEXT_PALETTE[number]> = {};
    texts.forEach((t, i) => { m[t.name] = TEXT_PALETTE[i % TEXT_PALETTE.length]; });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.nodes]);
  const colorForTok = (tok: string) => {
    if (isRefTok(tok)) {
      const n = parseInt(tok.replace(/\D/g, ""), 10) || 1;
      return REF_PALETTE[(n - 1) % REF_PALETTE.length];
    }
    return textColor[tok.slice(1, -1)] || TEXT_PALETTE[0];
  };

  /* ── mutations ── */
  // Reference images live inside the prompt node as a reorderable deck (no canvas nodes).
  const refDrag = useRef<number | null>(null); // deck reorder: dragged card index
  const addRef = (img: string | null = null) => commit((p) => {
    const n = p.nodes.filter((x) => x.type === "ref").length + 1;
    return {
      ...p,
      nodes: [...p.nodes, { id: nid("r"), type: "ref", img: img ?? null, userInput: false }],
      // Every reference image is also listed in the prompt as its own token.
      body: p.body.replace(/\s*$/, "") + (p.body.trim() ? " " : "") + "[Reference Image " + n + "]",
    };
  });
  const moveRef = (from: number, to: number) => {
    /* No-op BEFORE commit: commit() pushes history unconditionally, so a
       self-drop used to burn one undo step and wipe the redo stack even
       though nothing moved (found by review, 2026-08-22). */
    if (from === to || from < 0 || to < 0) return;
    commit((p) => {
    const refs = p.nodes.filter((n) => n.type === "ref");
    if (from >= refs.length || to >= refs.length) return p;
    const order = refs.slice(); const [m] = order.splice(from, 1); order.splice(to, 0, m);
    // Tokens in the prompt follow their IMAGE through the reorder: old index →
    // new index, swapped via temp markers so replacements can't collide.
    let body = p.body;
    order.forEach((r, newIdx) => {
      const oldIdx = refs.findIndex((x) => x.id === r.id) + 1;
      body = body.split("[Reference Image " + oldIdx + "]").join("[[REF_TMP_" + (newIdx + 1) + "]]");
    });
    order.forEach((_, newIdx) => {
      body = body.split("[[REF_TMP_" + (newIdx + 1) + "]]").join("[Reference Image " + (newIdx + 1) + "]");
    });
    return { ...p, nodes: [...p.nodes.filter((n) => n.type !== "ref"), ...order], body };
    });
  };
  /** Finish a card drag at the promised insertion slot (original-order
      index). Slot > from shifts by one because the card is lifted out first.
      Every drop handler routes through here, so a release can never do
      something the bar did not show. */
  const dropRefAt = (ins: number | null) => {
    const from = refDrag.current;
    refDrag.current = null; setRefDragI(null); setRefInsI(null);
    if (from === null || ins === null) return;
    moveRef(from, ins > from ? ins - 1 : ins);
  };
  const toggleRefUserInput = (id: string) => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, userInput: !n.userInput } : n)) }));
  const addText = (atPos?: { x: number; y: number }, presetName?: string) => commit((p) => {
    const existing = p.nodes.filter((n) => n.type === "text");
    const k = existing.length + 1;
    const used = new Set(existing.map((n) => n.name));
    /* A preset name that already backs a node is a no-op, not a second node.
       Only the AUTO name was deduplicated; a presetName — the in-place token
       editor spawning a node for a typed [token] — went straight through, so
       typing [foo] twice, or renaming a token onto a name in use, produced two
       nodes with one name. Downstream that is two rail cards for one token,
       one of them with no chip to anchor to (it floats at the rail's bottom —
       Kev's "viel zu viel Abstand"), and React's duplicate-key error on the
       connector lines. The token is already in the body and the node already
       exists; there is nothing left to add. */
    if (presetName && used.has(presetName)) return p;
    // presetName: the in-place token editor spawns the node for an already
    // typed [token], so the node must carry exactly that name.
    let name = presetName ?? "var_" + k;
    if (!presetName) { let kk = k; while (used.has(name)) { kk++; name = "var_" + kk; } }
    const base = p.nodes.find((n) => n.id === "prompt")!;
    const d = NODE_DIM.text;
    // Drag-release drops it exactly there; otherwise text inputs stack
    // vertically (untereinander) in a column just left of the prompt. The 80px
    // gap (mirroring the output side) leaves the input bus-trunk in open space
    // so each cable's run is clearly visible as nodes are spawned.
    let x: number, y: number;
    if (atPos) { x = atPos.x; y = atPos.y; }
    else {
      x = (base.x || 0) - d.w - 80;
      y = existing.length ? Math.max(...existing.map((n) => n.y || 0)) + d.h + 14 : (base.y || 0);
    }
    const node: NodeT = { id: nid("t"), type: "text", x, y, name, kind: "text", pub: true, value: "" };
    // A preset-named node backs an already TYPED token — don't append it again.
    const tokenAlready = !!presetName && p.body.includes("[" + name + "]");
    return { ...p, nodes: [...p.nodes, node], body: tokenAlready ? p.body : p.body.replace(/\s*$/, "") + " [" + name + "]" };
  });
  const allFilled = () => stRef.current.nodes.filter((n) => n.type === "text").every((t) => t.kind === "bool" || (t.value && t.value.trim()));

  /* ── Chip drag & drop inside the prompt text ──
     Click = open the in-place editor; drag (>6px) = move the token to a new
     spot in the text. While dragging, the TEXTAREA CARET follows the pointer
     (the drop position is always visible), and on drop the caret lands right
     after the moved token. Works for text vars AND reference-image chips. */
  /** Viewport rect of the text caret at `off`. Feeds both the drop marker's
      position and the "is this point below the last line" test. */
  const caretRectAt = (off: number): DOMRect | null => {
    const ov = ovRef.current; if (!ov) return null;
    const doc = ov.ownerDocument;
    const w = doc.createTreeWalker(ov, NodeFilter.SHOW_TEXT);
    let total = 0, node: Node | null = null, local = 0, cur: Node | null;
    while ((cur = w.nextNode())) {
      const len = (cur.textContent || "").length;
      if (off <= total + len) { node = cur; local = off - total; break; }
      total += len;
    }
    if (!node) return null;
    const r = doc.createRange();
    r.setStart(node, local); r.setEnd(node, local);
    const rect = r.getBoundingClientRect();
    if (rect.height) return rect;
    // A collapsed range can measure as nothing - widen it by one character
    // and keep the edge the caret actually sits on.
    const len = (node.textContent || "").length;
    if (local < len) { r.setEnd(node, local + 1); const e = r.getBoundingClientRect(); return new DOMRect(e.left, e.top, 0, e.height); }
    if (local > 0) { r.setStart(node, local - 1); const e = r.getBoundingClientRect(); return new DOMRect(e.right, e.top, 0, e.height); }
    return null;
  };

  const caretOffsetFromPoint = (x: number, y: number): number | null => {
    const ov = ovRef.current; if (!ov) return null;
    /* Past the LAST line the browser folds y back onto that line and answers
       with whatever happens to sit at x. Measured 2026-08-22 on a prompt
       ending in a chip: a point in the empty space below the text resolved to
       the MIDDLE of the last chip (offset 156 of 171), which
       snapOutsideTokens then pushed to the position BEFORE it - so the end of
       the text simply could not be reached by dragging. Below the text the
       caret belongs at the end, as in any editor; above it, at the start. */
    const bodyLen = stRef.current.body.length;
    const endRect = caretRectAt(bodyLen);
    if (endRect && y > endRect.bottom) return bodyLen;
    const startRect = caretRectAt(0);
    if (startRect && y < startRect.top) return 0;
    const doc = ov.ownerDocument as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null, off = 0;
    if (doc.caretRangeFromPoint) { const r = doc.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
    else if (doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset; } }
    if (!node || !ov.contains(node)) return null;
    // Element hit (line gap): the offset is a CHILD INDEX. An index equal to
    // childNodes.length means "after the last child" - the end of that
    // element's text. Clamping it to the last child (and resetting off to 0)
    // turned every past-the-end hit into a position BEFORE the last chip.
    if (node.nodeType !== Node.TEXT_NODE) {
      const el = node as Element;
      if (off >= el.childNodes.length) {
        const before = textBefore(el);
        return before === null ? null : Math.min(before + (el.textContent || "").length, stRef.current.body.length);
      }
      node = el.childNodes[off] ?? el;
      off = 0;
    }
    let total = 0;
    const walker = doc.createTreeWalker(ov, NodeFilter.SHOW_TEXT);
    let cur: Node | null;
    while ((cur = walker.nextNode())) {
      if (cur === node) return Math.min(total + off, stRef.current.body.length);
      if (node.nodeType !== Node.TEXT_NODE && (node as Node).contains?.(cur)) return Math.min(total, stRef.current.body.length);
      total += (cur.textContent || "").length;
    }
    return Math.min(total, stRef.current.body.length);
  };

  /** Characters of prompt text that precede `target` in the overlay. */
  const textBefore = (target: Node): number | null => {
    const ov = ovRef.current; if (!ov) return null;
    let total = 0;
    const w = ov.ownerDocument.createTreeWalker(ov, NodeFilter.SHOW_TEXT);
    let cur: Node | null;
    while ((cur = w.nextNode())) {
      if (target.contains(cur)) return total;
      total += (cur.textContent || "").length;
    }
    return total;
  };

  /** A drop must never land INSIDE another token — snap to the nearer edge. */
  const snapOutsideTokens = (off: number): number => {
    const body = stRef.current.body;
    const re = new RegExp(TOKEN_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const s = m.index, e = s + m[0].length;
      if (off > s && off < e) return off - s < e - off ? s : e;
    }
    return off;
  };

  /** The render-time offset can be stale (fast successive drags land before a
      re-render). Re-locate the dragged token in the LIVE body — exact slice
      match first, else the occurrence nearest the remembered position. A
      splice must never run on guessed offsets: that's how brackets of OTHER
      tokens got cut and chips fell apart. */
  const locateTok = (part: string, near: number): number | null => {
    const body = stRef.current.body;
    if (body.slice(near, near + part.length) === part) return near;
    let best: number | null = null;
    for (let i = body.indexOf(part); i !== -1; i = body.indexOf(part, i + 1)) {
      if (best === null || Math.abs(i - near) < Math.abs(best - near)) best = i;
    }
    return best;
  };

  /* The drop marker. The textarea's own caret is a blinking 1px hairline -
     over 15px serif and coloured chips it was easy to lose, so you could not
     tell where the token would land (Kev, 2026-08-22). This one is drawn in
     the prompt box: ember, capped top and bottom, and it GLIDES to each new
     position so the eye follows it. Imperative like the drag ghost: a React
     state update per pointermove would re-render the whole editor. */
  const dropCaretRef = useRef<HTMLDivElement | null>(null);
  const showDropCaret = (off: number) => {
    const ov = ovRef.current; const box = ov?.parentElement;
    if (!ov || !box) return;
    const rect = caretRectAt(off); if (!rect) return;
    let el = dropCaretRef.current;
    if (!el) {
      el = ov.ownerDocument.createElement("div");
      el.className = "nc-dropcaret";
      box.appendChild(el);
      dropCaretRef.current = el;
    }
    const b = box.getBoundingClientRect();
    el.style.height = rect.height + "px";
    el.style.transform = "translate(" + (rect.left - b.left) + "px," + (rect.top - b.top) + "px)";
  };
  const hideDropCaret = () => { dropCaretRef.current?.remove(); dropCaretRef.current = null; };

  /* "+ Variable" pill on a text selection — the doc view's exact pattern
     (Kev, 2026-08-22: the pill belongs in EVERY editor). Deferred 80ms and
     re-verified, because on a click into an existing selection the browser
     collapses it only after mouseup — a synchronous read flashes a phantom
     pill. Validation is the shared lib/editor/selection-variable. */
  const [selPill, setSelPill] = useState<{ x: number; y: number; start: number; end: number } | null>(null);
  const selPillRef = useRef<typeof selPill>(null);
  useEffect(() => { selPillRef.current = selPill; }, [selPill]);
  const selPillT = useRef<number | null>(null);
  useEffect(() => () => { if (selPillT.current) window.clearTimeout(selPillT.current); }, []);
  useEffect(() => {
    const onSel = () => {
      setSelPill((p) => {
        if (!p) return p;
        const ta = taRef.current;
        return !ta || document.activeElement !== ta || ta.selectionStart === ta.selectionEnd ? null : p;
      });
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);
  const schedulePill = (e: { clientX?: number; clientY?: number }) => {
    const cx = e.clientX, cy = e.clientY;
    if (selPillT.current) window.clearTimeout(selPillT.current);
    selPillT.current = window.setTimeout(() => {
      selPillT.current = null;
      const ta = taRef.current; const box = ta?.parentElement;
      if (!ta || !box || document.activeElement !== ta) { setSelPill(null); return; }
      const s = ta.selectionStart, en = ta.selectionEnd;
      if (!variableRange(ta.value, s, en)) { setSelPill(null); return; }
      const r = box.getBoundingClientRect();
      const x = Math.max(8, Math.min((cx ?? r.left + 80) - r.left - 56, r.width - 150));
      const y = (cy ?? r.top + 40) - r.top + 18;
      setSelPill({ x, y, start: s, end: en });
    }, 80);
  };
  const addVariableFromSel = () => {
    if (!selPill) return;
    const r = variableRange(stRef.current.body, selPill.start, selPill.end);
    setSelPill(null);
    if (!r) return;
    pushHist();
    const body = stRef.current.body.slice(0, r.start) + "[" + r.name + "]" + stRef.current.body.slice(r.end);
    onBodyChange(body);
    addText(undefined, r.name); // no-op if a node of that name already exists
    requestAnimationFrame(() => {
      const ta = taRef.current; const caret = r.start + r.name.length + 2;
      if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); }
    });
  };

  const tokDrag = useRef<{ started: boolean; at: number | null } | null>(null);
  const beginTokPointer = (part: string, renderStart: number, e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const sx = e.clientX, sy = e.clientY;
    let ghost: HTMLElement | null = null;
    tokDrag.current = { started: false, at: null };
    const ov = ovRef.current;
    const onMove = (ev: PointerEvent) => {
      const d = tokDrag.current; if (!d) return;
      if (!d.started) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return;
        d.started = true;
        if (ov) {
          ov.style.pointerEvents = "auto"; // caret hit-testing everywhere
          ov.classList.add("nc-dragging"); // suppress hover paint on other chips
        }
        el.classList.add("nc-tok-src"); // highlight WHICH chip is being moved
        ghost = el.cloneNode(true) as HTMLElement;
        ghost.style.cssText += ";position:fixed;z-index:2000;pointer-events:none;opacity:.9;";
        document.body.appendChild(ghost);
      }
      if (ghost) { ghost.style.left = ev.clientX + 10 + "px"; ghost.style.top = ev.clientY + 12 + "px"; }
      const off = caretOffsetFromPoint(ev.clientX, ev.clientY);
      if (off != null) {
        const snapped = snapOutsideTokens(off);
        d.at = snapped; // what the marker promises is what the drop must do
        showDropCaret(snapped);
        const ta = taRef.current;
        if (ta) { ta.focus(); ta.setSelectionRange(snapped, snapped); } // caret follows the drag
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const d = tokDrag.current; tokDrag.current = null;
      ghost?.remove();
      hideDropCaret();
      el.classList.remove("nc-tok-src");
      if (ov) { ov.style.pointerEvents = ""; ov.classList.remove("nc-dragging"); }
      if (!d) return;
      if (!d.started) {
        // plain click: text vars open the editor; ref chips have nothing to edit
        if (!isRefTok(part)) openTokEdit(part, el);
        return;
      }
      const start = locateTok(part, renderStart);
      if (start === null) return; // token vanished — never splice blindly
      const end = start + part.length;
      /* If the release point hit-tests to nothing (the pointer left the box),
         use the last position the marker showed - the drop must always do
         what the indicator promised, never silently nothing. */
      const off = caretOffsetFromPoint(ev.clientX, ev.clientY);
      const target = off != null ? snapOutsideTokens(off) : d.at;
      if (target == null) return;
      if (target >= start && target <= end) return; // dropped onto itself
      pushHist();
      let caret: number | null = null;
      setSt((p) => {
        /* p.body is the source of truth — re-check that THIS token still sits
           at these offsets before splicing, and let moveToken (unit-tested,
           lib/editor/move-token.ts) do the index work. */
        const moved = p.body.slice(start, end) === part ? moveToken(p.body, start, end, target) : null;
        if (!moved) return p;
        caret = moved.caret;
        return { ...p, body: moved.body };
      });
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta && caret !== null) { ta.focus(); ta.setSelectionRange(caret, caret); }
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /* ── In-place token editing (click a chip in the prompt) ── */
  const openTokEdit = (tok: string, el: HTMLElement) => {
    const name = tok.slice(1, -1);
    // No input node for this token yet (typed by hand)? Spawn it silently so
    // the value has somewhere to live — same as dragging one off the port.
    if (!stRef.current.nodes.some((n) => n.type === "text" && n.name === name)) {
      addText(undefined, name);
    } else {
      pushHist(); // one undo step per edit session
    }
    const r = el.getBoundingClientRect();
    setTokEdit({ name, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
  };
  const setTokValue = (name: string, v: string) =>
    setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.type === "text" && n.name === name ? { ...n, value: v } : n)) }));

  // 🎲 → one coherent AI-invented set for the variable defaults. Applies ONLY
  // the ids the dice returned, keyed by node id so a rename while the roll is
  // in flight cannot mis-target; untouched vars keep the artist's values.
  // Via commit: the whole roll is a single undo step.
  const applyDiceValues = (values: Record<string, DiceValue>) => commit((p) => ({
    ...p,
    nodes: p.nodes.map((n) => n.type === "text" && n.id in values
      ? { ...n, value: n.kind === "bool" ? (values[n.id] ? "on" : "off") : String(values[n.id]) }
      : n),
  }));

  // Add an empty output slot; Generate fills every empty slot at once.
  // With a drop position it sits exactly there (free); otherwise it joins the current row.
  const addOutput = (atPos?: { x: number; y: number }) => commit((p) => {
    if (atPos) {
      return { ...p, nodes: [...p.nodes, { id: nid("o"), type: "output", x: atPos.x, y: atPos.y, img: null, status: "empty", picked: false }] };
    }
    const tx = p.nodes.filter((n) => n.type === "text") as TextNode[];
    const sig = sigOf(p.body, tx);
    let cons = (p.cons || []).slice(); let conSeq = p.conSeq || 0;
    if (!cons.some((c) => c.sig === sig)) { cons = [{ sig, body: p.body, cidx: conSeq }, ...cons]; conSeq += 1; }
    const vals: Record<string, string> = {}; tx.forEach((t) => { vals["[" + t.name + "]"] = t.value; });
    return { ...p, cons, conSeq, nodes: [...p.nodes, { id: nid("o"), type: "output", sig, vals, img: null, status: "empty", picked: false }] };
  });

  /* ── real async generation (Nano Banana Pro via Puter, free) ── */
  const finalizeOutput = useCallback(async (oid: string, promptText: string) => {
    const ratio = stRef.current.ratio && stRef.current.ratio !== "Any" ? stRef.current.ratio : "1:1";
    // Mock-up mode: skip the API and drop in instant placeholder art.
    if (mockModeRef.current) {
      const mock = placeholderArt("mock" + oid + ":" + promptText.slice(0, 24), ratio);
      setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === oid ? { ...n, img: mock, status: "ready" } : n)) }));
      return;
    }
    // Routed by the model the user actually picked. This used to call the free
    // endpoint unconditionally, so "Nano Banana Pro" and a displayed price
    // produced free flux from a different model.
    //
    // The graph goes with the request so the generation can be re-run later;
    // buildExportJSON() reads from refs, so calling it here needs no extra
    // dependency. The server pulls the image bytes and the authored text out
    // of it before storing.
    const picked = resolveCatalogueEntry(catalogueRef.current, stRef.current.models[0]);
    const tier = (["1K", "2K", "4K"] as const).find((t) => t === stRef.current.quality);
    const outcome = tier
      ? await runGeneration(
          {
            model: picked,
            resolution: tier,
            quality: qualityRef.current,
            boost: boostRef.current,
            prompt: promptText,
            aspectRatio: ratio,
            workflow: buildExportJSON(),
          },
          signPayment,
        )
      : ({ ok: false, error: "Pick a resolution first. Nothing was generated and nothing was charged." } as const);

    if (!outcome.ok) {
      // The slot stays empty and says why. A placeholder used to stand in as a
      // finished "ready" image, which could be picked and released as if a
      // model had made it.
      onToast(outcome.error);
      setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === oid ? { ...n, img: null, status: "empty" } : n)) }));
      return;
    }
    persistCreation({ prompt: promptText, imageUrl: outcome.imageUrl, model: picked?.id ?? "", title: stRef.current.title, userKey });
    setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === oid ? { ...n, img: outcome.imageUrl, status: "ready" } : n)) }));
  }, [onToast, userKey, signPayment]);

  /* ▶ generate → new output in the current constellation row.
     Never reassigns/removes an empty slot that belongs to a DIFFERENT prompt
     composition — those are left alone and offered via a co-generate dialog. */
  const spawnOutput = (autofill?: boolean) => {
    if (!stRef.current.body.trim()) return;
    if (!resolveCatalogueEntry(catalogueRef.current, stRef.current.models[0])) { onToast("Pick a model first"); return; }
    // strict check: node-view buttons pass the click event as the first arg
    const wantsAutofill = autofill === true;
    const baseTx = stRef.current.nodes.filter((n) => n.type === "text") as TextNode[];
    const rv = wantsAutofill ? randVals(baseTx) : null;
    const tx: TextNode[] = rv ? baseTx.map((t) => ({ ...t, value: rv["[" + t.name + "]"] ?? t.value })) : baseTx;
    const body = stRef.current.body;
    const vals: Record<string, string> = {}; tx.forEach((t) => { vals["[" + t.name + "]"] = t.value; });
    const finalPrompt = buildPrompt(body, tx, vals, stRef.current.nodes);
    // Mirror the AI-filled values into the editor vars, like runGenerate does.
    const withFill = (nodes: NodeT[]) => (rv ? nodes.map((n) => (n.type === "text" ? { ...n, value: rv["[" + n.name + "]"] ?? n.value } : n)) : nodes);
    const sig = sigOf(body, tx);
    // empties belonging to THIS composition (or sig-less) → fill them now.
    const mine = stRef.current.nodes.filter((n) => n.type === "output" && n.status === "empty" && (!n.sig || n.sig === sig));
    // empties created for OTHER compositions → never touch; offer to co-generate.
    const others = stRef.current.nodes.filter((n) => n.type === "output" && n.status === "empty" && n.sig && n.sig !== sig);
    pushHist();
    if (mine.length) {
      const ids = mine.map((e) => e.id);
      setSt((p) => {
        let cons = (p.cons || []).slice(); let conSeq = p.conSeq || 0;
        if (!cons.some((c) => c.sig === sig)) { cons = [{ sig, body: p.body, cidx: conSeq }, ...cons]; conSeq += 1; }
        return { ...p, cons, conSeq, nodes: withFill(p.nodes).map((n) => (ids.includes(n.id) ? { ...n, sig, vals, status: "loading" } : n)) };
      });
      ids.forEach((id) => finalizeOutput(id, finalPrompt));
    } else {
      const oid = nid("o");
      setSt((p) => {
        let cons = (p.cons || []).slice(); let conSeq = p.conSeq || 0;
        if (!cons.some((c) => c.sig === sig)) { cons = [{ sig, body: p.body, cidx: conSeq }, ...cons]; conSeq += 1; }
        return { ...p, cons, conSeq, nodes: [...withFill(p.nodes), { id: oid, type: "output", sig, vals, img: null, status: "loading", picked: false }] };
      });
      setPulseId(oid); setTimeout(() => setPulseId((v) => (v === oid ? null : v)), 2800);
      finalizeOutput(oid, finalPrompt);
    }
    if (others.length) setGenConfirm({ ids: others.map((o) => o.id), checked: new Set(others.map((o) => o.id)) });
  };
  // Co-generate dialog: which leftover empty slots (from other settings) to also run.
  const [genConfirm, setGenConfirm] = useState<{ ids: string[]; checked: Set<string> } | null>(null);
  // Mirror of "something is open/in progress" for the ESC handler (whose deps
  // are deliberately narrow) — busy ESC cancels; neutral ESC starts the close flow.
  const escBusyRef = useRef(false);
  useEffect(() => {
    escBusyRef.current = !!(connectLine || marquee || menuOpen || modelOpen || refMax || genConfirm);
  }, [connectLine, marquee, menuOpen, modelOpen, refMax, genConfirm]);
  const confirmCoGen = () => {
    if (!genConfirm) return;
    const ids = [...genConfirm.checked];
    pushHist();
    ids.forEach((id) => {
      const o = stRef.current.nodes.find((n) => n.id === id); if (!o) return;
      const con = (stRef.current.cons || []).find((c) => c.sig === o.sig);
      const bodyC = con?.body || stRef.current.body;
      const txC = stRef.current.nodes.filter((n) => n.type === "text") as TextNode[];
      const fp = buildPrompt(bodyC, txC, o.vals || {}, stRef.current.nodes);
      setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, status: "loading" } : n)) }));
      finalizeOutput(id, fp);
    });
    setGenConfirm(null);
  };

  // Only ONE output group can be up for release: picking an image in a new group
  // clears every pick in the other groups.
  const togglePick = (id: string) => setSt((p) => {
    const target = p.nodes.find((n) => n.id === id);
    if (!target) return p;
    const on = !target.picked, sig = target.sig;
    return { ...p, nodes: p.nodes.map((n) => {
      if (n.id === id) return { ...n, picked: on };
      if (on && n.type === "output" && n.sig !== sig && n.picked) return { ...n, picked: false };
      return n;
    }) };
  });
  const setOutVal = (id: string, tok: string, v: string) => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, vals: { ...(n.vals || {}), [tok]: v } } : n)) }));
  const pushValuesLeft = (id: string) => {
    commit((p) => {
      const o = p.nodes.find((n) => n.id === id);
      const vals = (o && o.vals) || {};
      return { ...p, nodes: p.nodes.map((n) => (n.type === "text" && vals["[" + n.name + "]"] !== undefined ? { ...n, value: vals["[" + n.name + "]"] } : n)) };
    });
    setConfirmPush(null);
    onToast("Variable values copied to the editor on the left");
  };

  const deleteNodeId = (id: string) => commit((p) => {
    const node = p.nodes.find((n) => n.id === id);
    if (!node || node.type === "prompt") return p;
    const nodes = p.nodes.filter((n) => n.id !== id && n.wfOf !== id);
    let body = p.body;
    if (node.type === "text") body = body.split("[" + node.name + "]").join("").replace(/\s{2,}/g, " ").trim();
    if (node.type === "workflow") body = body.split(wfToken(node.id)).join("").replace(/\s{2,}/g, " ").trim();
    if (node.type === "ref") {
      // Drop the deleted image's token and renumber the ones behind it.
      const refs = p.nodes.filter((n) => n.type === "ref");
      const k = refs.findIndex((r) => r.id === id) + 1;
      if (k > 0) {
        body = body.split("[Reference Image " + k + "]").join("");
        for (let m = k + 1; m <= refs.length; m++) {
          body = body.split("[Reference Image " + m + "]").join("[Reference Image " + (m - 1) + "]");
        }
        body = body.replace(/\s{2,}/g, " ").trim();
      }
    }
    return { ...p, nodes, body };
  });

  // Delete a whole constellation group: its prompt-variant + every output in it.
  const deleteRow = (sig: string) => commit((p) => ({
    ...p,
    cons: (p.cons || []).filter((c) => c.sig !== sig),
    nodes: p.nodes.filter((n) => !(n.type === "output" && n.sig === sig)),
  }));

  const renameText = (id: string, newName: string) => setSt((p) => {
    const node = p.nodes.find((n) => n.id === id); if (!node) return p;
    const clean = newName.replace(/[[\]\n]/g, "");
    // "" would leave an unmatchable "[]" token (invisible, unrecoverable card);
    // a name collision would stack two cards on one token and starve the
    // second variable in buildPrompt — both renames are simply ignored.
    if (!clean.trim()) return p;
    if (p.nodes.some((n) => n.type === "text" && n.id !== id && n.name === clean)) return p;
    const body = p.body.split("[" + node.name + "]").join("[" + clean + "]");
    return { ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, name: clean } : n)), body };
  });
  const patchText = (id: string, patch: Partial<NodeT>) =>
    setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  // Switching the type NEVER loses content: the text value moves into the
  // checkbox snippet (str) and back. Shared by the node cards and the doc rail.
  const setTextKind = (id: string, kind: Kind) => setSt((p) => ({
    ...p,
    nodes: p.nodes.map((n) => {
      if (n.id !== id) return n;
      if (kind === "text") return { ...n, kind: "text", value: n.value === "on" || n.value === "off" || n.value === "Yes" ? (n.str || "") : n.value };
      return { ...n, kind: "bool", str: n.str && n.str.trim() ? n.str : n.value, value: n.value === "off" ? "off" : "on", pub: false };
    }),
  }));

  /* delete-key two-press on prompt tokens */
  const tokenAtCaret = () => {
    const ta = taRef.current; if (!ta) return null;
    const c = ta.selectionStart; let m: RegExpExecArray | null; const re = new RegExp(TOKEN_RE.source, "g");
    while ((m = re.exec(st.body)) !== null) { if (c >= m.index && c <= m.index + m[0].length) return m[0]; }
    return null;
  };
  const onPromptKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Backspace" || e.key === "Delete") {
      const tok = tokenAtCaret();
      if (tok) {
        // Deleting a token removes the whole token AND its variable node in one press.
        e.preventDefault();
        if (isRefTok(tok)) { const idx = +tok.match(/\d+/)![0]; const r = refs.find((x) => x.index === idx); if (r) deleteNodeId(r.id); }
        else { const t = texts.find((x) => x.name === tok.slice(1, -1)); if (t) deleteNodeId(t.id); }
      }
    }
  };
  // Keep the canvas in sync with the text: if a variable's [token] is no longer
  // anywhere in the prompt body, drop its text node too.
  const onBodyChange = (val: string) => setSt((p) => {
    const present = new Set<string>();
    const re = /\[([^\]\n]+)\]/g; let m: RegExpExecArray | null;
    while ((m = re.exec(val)) !== null) present.add(m[1]);
    const existingNames = p.nodes.filter((n) => n.type === "text").map((n) => n.name || "");
    const removed = existingNames.filter((n) => !present.has(n));
    const added = [...present].filter((n) => !existingNames.includes(n));
    let nodes = p.nodes;
    if (removed.length === 1 && added.length === 1) {
      // Editing a token's name INSIDE the prompt ([var_6] → [var_x]) is a
      // RENAME: the input node keeps its position, value and settings — it
      // just carries the new name. (Deleting it and spawning a fresh node at
      // the bottom was the old, wrong behavior.)
      nodes = nodes.map((n) => (n.type === "text" && n.name === removed[0] ? { ...n, name: added[0] } : n));
    } else {
      nodes = nodes.filter((n) => n.type !== "text" || n.wfOf || present.has(n.name || ""));
      // Typing [brackets] CREATES the variable (both editors promise it) —
      // otherwise the literal token would leak into the generated prompt.
      const toAdd = added.filter((n) => n.trim() && !/^Reference Image \d+$/.test(n));
      if (toAdd.length) {
        const base = nodes.find((n) => n.id === "prompt")!;
        const dim = NODE_DIM.text;
        let texts = nodes.filter((n) => n.type === "text");
        for (const name of toAdd) {
          const y = texts.length ? Math.max(...texts.map((n) => n.y || 0)) + dim.h + 14 : (base.y || 0);
          const node: NodeT = { id: nid("t"), type: "text", x: (base.x || 0) - dim.w - 80, y, name, kind: "text", pub: true, value: "" };
          nodes = [...nodes, node];
          texts = [...texts, node];
        }
      }
    }
    return { ...p, body: val, nodes };
  });

  /* A model switch must never leave a ratio the new model does not take —
     "Any" is in every list, so this can never loop (found by review,
     2026-08-22). */
  useEffect(() => {
    const opts = ncRatios(selectedModel);
    if (!opts.includes(st.ratio)) setSt((p) => ({ ...p, ratio: "Any" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel, st.ratio]);

  /* ── pricing ── */
  /* Per-model tier scale from the server's own price ladder — the flat x2
     for 4K overstated it (nano-banana-pro's real 4K/2K ratio is ~1.79;
     found by review, 2026-08-22). */
  const qualityMult = tierScale(selectedModel, st.quality);
  // Priced from the catalogue, so what is shown is what the server will
  // charge. It used to come from a constant with invented numbers.
  const perImage = st.models.reduce((sum, id) => sum + (resolveCatalogueEntry(catalogue, id)?.price ?? 0), 0) * qualityMult;
  const imgCount = st.genCount;
  const cost = perImage * imgCount;
  /* Boost price = the BOOST ROUTE's real per-image cost (vendor direct),
     never a multiplier (Kev, 2026-08-23). Uses the same family key the
     server prices by; the gpt quality lever feeds in where the model has
     one. */
  const boostCost = selectedModel
    ? apiBoostPricePerImage(toModelFamily(selectedModel.name), st.quality, supportsQuality ? quality : undefined) * imgCount
    : cost;
  const shownCost = boost ? boostCost : cost;
  const pickedOuts = outs.filter((o) => o.picked && o.img); // images marked for public release (always one group)
  const releaseMin = st.mode === "free" ? 1 : 4;            // Free needs ≥1, Premium ≥4 selected
  const canRelease = pickedOuts.length >= releaseMin;

  /* dock batch generate */
  const runGenerate = (autofill: boolean) => {
    if (!stRef.current.body.trim()) { onToast("Write a prompt first"); return; }
    const picked = resolveCatalogueEntry(catalogueRef.current, stRef.current.models[0]);
    if (!picked) { onToast("Pick a model first"); return; }
    pushHist();
    const n = st.genCount;
    const baseTx = stRef.current.nodes.filter((nn) => nn.type === "text") as TextNode[];
    const rv = autofill ? randVals(baseTx) : null;
    const resolved: TextNode[] = baseTx.map((t) => ({ ...t, value: autofill && rv ? (rv["[" + t.name + "]"] ?? t.value) : t.value }));
    const body = stRef.current.body;
    const sig = sigOf(body, resolved);
    const created: { oid: string; vals: Record<string, string>; prompt: string }[] = [];
    for (let i = 0; i < n; i++) {
      const vals: Record<string, string> = {}; resolved.forEach((t) => { vals["[" + t.name + "]"] = t.value; });
      created.push({ oid: nid("o"), vals, prompt: buildPrompt(body, resolved, vals, stRef.current.nodes) });
    }
    setSt((p) => {
      let nodes = p.nodes.map((x) => ({ ...x }));
      if (autofill && rv) nodes = nodes.map((nn) => (nn.type === "text" ? { ...nn, value: rv["[" + nn.name + "]"] ?? nn.value } : nn));
      let cons = (p.cons || []).slice(); let conSeq = p.conSeq || 0;
      if (!cons.some((c) => c.sig === sig)) { cons = [{ sig, body: p.body, cidx: conSeq }, ...cons]; conSeq += 1; }
      created.forEach((c) => nodes.push({ id: c.oid, type: "output", sig, vals: c.vals, img: null, status: "loading", picked: false }));
      return { ...p, cons, conSeq, nodes };
    });
    created.forEach((c) => finalizeOutput(c.oid, c.prompt));
    onToast((autofill ? "Auto-filled & generating " : "Generating ") + n + " image" + (n > 1 ? "s" : "") + " · " + picked.name);
  };

  /* Lineage: when this editor was opened from another prompt ("put prompt
     to editor"), the parent's id rides along and goes into the release body
     as derivedFrom — prompts.derived_from_prompt_id is how Kev traces which
     prompt was built from which (and later, how creator payout splits know
     their chain). Held in a ref: a draft save/restore may lose it, but a
     wrong parent is worse than a missing one. */
  const derivedFromRef = useRef<string | undefined>(
    (editPrompt as { derivedFrom?: string } | null)?.derivedFrom,
  );

  const release = () => {
    const need = st.mode === "free" ? 1 : 4;
    const ready = outs.filter((o) => o.img && o.status === "ready");
    const picked = ready.filter((o) => o.picked);
    if (ready.length < need) { onToast("Generate " + need + " example" + (need > 1 ? "s" : "") + " first — fill variables and click ▶ on the prompt (" + ready.length + "/" + need + ")"); return; }
    if (picked.length < need) { onToast("Select " + need + " output" + (need > 1 ? "s" : "") + " to publish — tap the ★ on the ones you want shown (" + picked.length + "/" + need + ")"); return; }
    /* When this becomes a real API release, derivedFromRef.current MUST ride
       in the body as derivedFrom — the lineage column already exists. */
    void derivedFromRef.current;
    onToast(picked.length + " selected output" + (picked.length > 1 ? "s" : "") + " published · prompt released to marketplace");
    clearDraft(); // released — a stale draft must not resurrect the old graph
    onClose();
  };

  /* ── dragging ── */
  const drag = useRef<{ kind: string; sx: number; sy: number; id?: string; ox: number; oy: number; sig?: string; portType?: string; from?: { x: number; y: number }; color?: string; moved?: boolean } | null>(null);
  const rightPan = useRef({ active: false, moved: false }); // right-drag pans; suppresses the context menu if it moved
  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (d.kind === "pan") { setPan({ x: d.ox + dx, y: d.oy + dy }); if (rightPan.current.active && Math.abs(dx) + Math.abs(dy) > 4) rightPan.current.moved = true; }
    else if (d.kind === "node") setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === d.id ? { ...n, x: d.ox + dx / zoomRef.current, y: d.oy + dy / zoomRef.current } : n)) }));
    else if (d.kind === "dock") {
      setDock({ x: d.ox + dx, y: d.oy + dy, placed: true });
      // Dock only when the CURSOR itself is right at the canvas edge.
      const EDGE = 8;
      pendingDockSide.current = (e.clientX - sidebarWRef.current) <= EDGE ? "left" : (e.clientX >= window.innerWidth - EDGE ? "right" : null);
    }
    else if (d.kind === "connect") {
      const to = { x: (e.clientX - sidebarWRef.current - panRef.current.x) / zoomRef.current, y: (e.clientY - panRef.current.y) / zoomRef.current };
      if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
      setConnectLine({ from: d.from!, to, color: d.color! });
    }
    else if (d.kind === "outoff") setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === d.id ? { ...n, off: { x: d.ox + dx / zoomRef.current, y: d.oy + dy / zoomRef.current } } : n)) }));
    else if (d.kind === "marquee") {
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      setMarquee({ x0: d.sx, y0: d.sy, x1: e.clientX, y1: e.clientY });
      // live touch-select: a node is selected the moment the box touches it
      const box = { left: Math.min(d.sx, e.clientX), top: Math.min(d.sy, e.clientY), right: Math.max(d.sx, e.clientX), bottom: Math.max(d.sy, e.clientY) };
      const ids: string[] = [];
      document.querySelectorAll<HTMLElement>(".nc-node[data-nid]").forEach((el) => {
        const r = el.getBoundingClientRect(); const id = el.getAttribute("data-nid");
        if (id && id !== "prompt" && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top) ids.push(id);
      });
      setSelSet(new Set(ids));
    }
    else if (d.kind === "row") setSt((p) => ({ ...p, cons: (p.cons || []).map((c) => (c.sig === d.sig ? { ...c, off: { x: d.ox + dx / zoomRef.current, y: d.oy + dy / zoomRef.current } } : c)) }));
  }, []);
  const endDrag = useCallback((e: PointerEvent) => {
    const d = drag.current; drag.current = null;
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onPointerMove); window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    if (!d) return;
    /* pointercancel is an ABORT (touch scroll takeover, browser gesture):
       clean up, but never commit — a cancelled connect-drag must not spawn a
       node at the cancel event's bogus coordinates, and a cancelled dock
       drag must not move the dock. Mirrors the ESC path above. */
    const aborted = e.type === "pointercancel";
    if (d.kind === "pan") { rightPan.current.active = false; setPanning(false); } // keep `moved` for the contextmenu that fires next
    if (d.kind === "dock" && !aborted) setDockSide(pendingDockSide.current);
    if (d.kind === "connect") {
      setConnectLine(null);
      if (d.moved && !aborted) {
        const pos = { x: (e.clientX - sidebarWRef.current - panRef.current.x) / zoomRef.current, y: (e.clientY - panRef.current.y) / zoomRef.current };
        spawnFromPortKind(d.portType!, pos);
      }
    }
    if (d.kind === "marquee") {
      setMarquee(null);
      if (!d.moved) setSelSet(new Set()); // a plain click clears; a drag kept its live selection
    }
  }, [onPointerMove]);
  const startDrag = (kind: string, e: React.PointerEvent, extra: Record<string, unknown>) => {
    e.stopPropagation();
    if (kind === "pan") setPanning(true);
    drag.current = { kind, sx: e.clientX, sy: e.clientY, ox: 0, oy: 0, ...extra } as typeof drag.current;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onPointerMove); window.addEventListener("pointerup", endDrag);
    /* pointercancel too: starting a NATIVE drag (the ref cards are
       draggable) aborts the pointer stream with pointercancel — pointerup
       never fires. Without this, a pan armed by the same pointerdown stayed
       live after the drop and the view chased the mouse (Kev, 2026-08-22). */
    window.addEventListener("pointercancel", endDrag);
  };
  // Ctrl/⌘+click toggles a node in/out of the multi-selection.
  const toggleSel = (id: string) => setSelSet((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const startNodeDrag = (id: string, e: React.PointerEvent) => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); toggleSel(id); return; } const n = st.nodes.find((x) => x.id === id)!; pushHist(); setSel(id); setSelRow(null); setSelSet(new Set()); startDrag("node", e, { id, ox: n.x || 0, oy: n.y || 0 }); };
  // Output nodes are positioned by the constellation grid, so dragging moves an offset on top.
  const startOutDrag = (id: string, e: React.PointerEvent) => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); toggleSel(id); return; } const n = st.nodes.find((x) => x.id === id); const off = n?.off || { x: 0, y: 0 }; pushHist(); setSel(id); setSelRow(null); setSelSet(new Set()); startDrag("outoff", e, { id, ox: off.x, oy: off.y }); };
  const startRowDrag = (sig: string, e: React.PointerEvent) => {
    setSel(null); setSelRow(sig);
    const con = (st.cons || []).find((c) => c.sig === sig); const off = (con && con.off) || { x: 0, y: 0 };
    if (!con) setSt((p) => ({ ...p, cons: [{ sig, body: p.body, cidx: p.conSeq || 0, off: { x: 0, y: 0 } }, ...(p.cons || [])], conSeq: (p.conSeq || 0) + 1 }));
    startDrag("row", e, { sig, ox: off.x, oy: off.y });
  };
  const startPan = (e: React.PointerEvent) => {
    setCtx(null); setZoomEditing(false);
    // Right-drag, middle-mouse, or Space-hold → pan the canvas.
    if (e.button === 2) { rightPan.current = { active: true, moved: false }; startDrag("pan", e, { ox: pan.x, oy: pan.y }); return; }
    if (e.button === 1 || spaceRef.current || tool === "hand") { startDrag("pan", e, { ox: pan.x, oy: pan.y }); return; }
    if (e.button !== 0) return;
    // Ctrl/⌘ + left-drag on empty canvas → marquee-select.
    if (e.ctrlKey || e.metaKey) {
      setSel(null); setSelRow(null);
      if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
      setMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      startDrag("marquee", e, {});
      return;
    }
    // Plain left-drag on empty canvas → pan the view; a plain click clears the selection.
    setSel(null); setSelRow(null); setSelSet(new Set());
    startDrag("pan", e, { ox: pan.x, oy: pan.y });
  };
  const startDock = (e: React.PointerEvent) => {
    const ncW = window.innerWidth - sidebarWRef.current;
    let dx: number, dy: number;
    if (dockSide === "left") { dx = 0; dy = 54; }
    else if (dockSide === "right") { dx = ncW - 216; dy = 54; }
    else { dx = dock.placed ? dock.x : ncW - 332; dy = dock.placed ? dock.y : dockTopRef.current; }
    setDockSide(null); pendingDockSide.current = null;
    startDrag("dock", e, { ox: dx, oy: dy });
  };

  /* ── ports: drag-out / double-click to spawn a connected node ── */
  const promptPortWorld = (pt: string) => { const x = prompt.x || 0, y = prompt.y || 0; if (pt === "out") return { x: x + 480, y: y + 123 }; return { x, y: y + 123 }; };
  const portColor = (pt: string) => (pt === "text" ? TEXT_PALETTE[0].dot : pt === "out" ? "var(--enki-ember)" : REF_COLOR.dot);
  // pos given (drag-release) → drop the node exactly there; no pos (double-click) → auto-place / generate.
  const spawnFromPortKind = (pt: string, pos?: { x: number; y: number }) => {
    // Drag-release offsets the new node so ITS connecting port lands on the drop point.
    if (pt === "text") { if (pos) addText({ x: pos.x - 250, y: pos.y - 30 }); else addText(); }
    else if (pt === "out") { if (pos) addOutput({ x: pos.x, y: pos.y - 30 }); else spawnOutput(); }
  };
  const startConnect = (pt: string, e: React.PointerEvent) => { const from = promptPortWorld(pt); setConnectLine({ from, to: from, color: portColor(pt) }); startDrag("connect", e, { portType: pt, from, color: portColor(pt), moved: false }); };
  const portDbl = (pt: string, e: React.MouseEvent) => { e.stopPropagation(); spawnFromPortKind(pt); };

  /* ── image input (real files, no placeholders) ── */
  const setRefImg = (id: string, url: string) => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, img: url } : n)) }));
  const readImages = (fileList: FileList | null): Promise<string[]> => {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    return Promise.all(files.map((f) => new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(f); })));
  };
  // Click/drop on one empty node: the first image fills it, extras become new reference nodes.
  const onRefFiles = async (id: string, fileList: FileList | null) => {
    const urls = await readImages(fileList);
    urls.forEach((url, i) => (i === 0 ? setRefImg(id, url) : addRef(url)));
  };
  // "+" on the deck → multi-file upload; every picked image becomes a ref card.
  const addRefsFromFiles = async (fileList: FileList | null) => {
    const urls = await readImages(fileList);
    if (!urls.length) return;
    // Per-model cap from the models table (max_reference_images).
    const current = stRef.current.nodes.filter((n) => n.type === "ref").length;
    const room = Math.max(0, modelLimits.maxRefs - current);
    if (room <= 0) { onToast(`${st.models[0]} allows at most ${modelLimits.maxRefs} reference images`); return; }
    if (urls.length > room) onToast(`Only ${room} more reference image${room === 1 ? "" : "s"} fit (${modelLimits.maxRefs} max for this model)`);
    const take = urls.slice(0, room);
    commit((p) => {
      const base = p.nodes.filter((x) => x.type === "ref").length;
      const tokens = take.map((_, i) => "[Reference Image " + (base + i + 1) + "]").join(" ");
      return {
        ...p,
        nodes: [...p.nodes, ...take.map((u) => ({ id: nid("r"), type: "ref", img: u, userInput: false } as NodeT))],
        body: p.body.replace(/\s*$/, "") + (p.body.trim() ? " " : "") + tokens,
      };
    });
  };
  // Drop anywhere on the canvas: fill empty reference nodes first, then add new ones.
  const onCanvasDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDropOn(false);
    const urls = await readImages(e.dataTransfer.files);
    if (!urls.length) return;
    const empties = stRef.current.nodes.filter((n) => n.type === "ref" && !n.img).map((n) => n.id);
    urls.forEach((url, i) => (i < empties.length ? setRefImg(empties[i], url) : addRef(url)));
  };

  /* ports & edges */
  // Exact centres of the rendered 15px port dots so edges always meet the dot.
  const portPos = (n: NodeT, which?: string) => {
    if (n.type === "prompt") {
      if (which === "text") return { x: n.x || 0, y: (n.y || 0) + 123 };
      if (which === "wf") return { x: n.x || 0, y: (n.y || 0) + 163 };
      return { x: (n.x || 0) + 480, y: (n.y || 0) + 123 };
    }
    if (n.type === "output") return { x: n.x || 0, y: (n.y || 0) + 30 };
    if (n.type === "workflow") return { x: (n.x || 0) + (n.open ? 340 : 300), y: (n.y || 0) + 25.5 };
    return { x: (n.x || 0) + (n.type === "ref" ? 172 : 250), y: (n.y || 0) + 30 };
  };
  // Shared "bus" lines (like PCB traces): inputs converge on a trunk just left
  // of the prompt; outputs all spring from a trunk just right of it.
  const IN_TRUNK = (prompt.x || 0) - 36;
  const OUT_TRUNK = (prompt.x || 0) + 480 + 36;
  // Output position = its grid/free slot + any drag offset.
  const outPos = (o: NodeT) => { const b = layout.map[o.id] || (o.status === "empty" ? { x: o.x || 0, y: o.y || 0 } : null); return b ? { x: b.x + (o.off?.x || 0), y: b.y + (o.off?.y || 0) } : null; };
  const edges: { from: { x: number; y: number }; to: { x: number; y: number }; trunk: number; c: string }[] = [];
  const wfNodes = st.nodes.filter((n) => n.type === "workflow");
  texts.forEach((t) => {
    const w = t.wfOf ? wfNodes.find((n) => n.id === t.wfOf) : undefined;
    if (w) edges.push({ from: portPos(t), to: { x: w.x || 0, y: (w.y || 0) + 25.5 }, trunk: (w.x || 0) - 36, c: (textColor[t.name] || TEXT_PALETTE[0]).dot });
    else edges.push({ from: portPos(t), to: portPos(prompt, "text"), trunk: IN_TRUNK, c: (textColor[t.name] || TEXT_PALETTE[0]).dot });
  });
  wfNodes.forEach((w) => edges.push({ from: portPos(w), to: portPos(prompt, "wf"), trunk: IN_TRUNK, c: "var(--enki-turq)" }));
  outs.forEach((o) => { const pos = outPos(o); if (pos) edges.push({ from: portPos(prompt, "out"), to: { x: pos.x, y: pos.y + 30 }, trunk: OUT_TRUNK, c: palOf((st.cons.find((c) => c.sig === o.sig) || { cidx: 0 }).cidx || 0).bar }); });
  // Rounded orthogonal path: run to the shared trunk x, then branch to the target.
  const path = (a: { x: number; y: number }, b: { x: number; y: number }, tx: number) => {
    if (Math.abs(b.y - a.y) < 1) return "M" + a.x + " " + a.y + " H" + b.x;
    const sy = b.y >= a.y ? 1 : -1, sx1 = tx >= a.x ? 1 : -1, sx2 = b.x >= tx ? 1 : -1;
    const r1 = Math.max(0, Math.min(9, Math.abs(tx - a.x), Math.abs(b.y - a.y) / 2));
    const r2 = Math.max(0, Math.min(9, Math.abs(b.x - tx), Math.abs(b.y - a.y) / 2));
    return ["M" + a.x + " " + a.y, "H" + (tx - sx1 * r1), "Q" + tx + " " + a.y + " " + tx + " " + (a.y + sy * r1),
      "V" + (b.y - sy * r2), "Q" + tx + " " + b.y + " " + (tx + sx2 * r2) + " " + b.y, "H" + b.x].join(" ");
  };

  const ctxAdd = (type: string) => { if (!ctx) return; const w = { x: ctx.wx, y: ctx.wy }; setCtx(null); if (type === "text") addText(w); else addOutput(w); };
  // Full-screen overlays (maximize / lightbox) portal above the sidebar (z-index
  // 120) into .ek-app so they cover the whole viewport, including the left menu.
  const portalRoot = typeof document !== "undefined" ? ((document.querySelector(".ek-app") as HTMLElement) || document.body) : null;
  // Generate dock is anchored to the upper-right corner, just below the toolbar.
  const dockTop = 64;
  dockTopRef.current = dockTop;

  return (
    <div className="nc" onDrop={onCanvasDrop} onDragOver={(e) => { if (!e.dataTransfer.types.includes("Files")) return; e.preventDefault(); setDropOn(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDropOn(false); }}>
      {/* canvas — stays MOUNTED in doc view (display:none) so pan/zoom and the
          wheel-handler wiring survive an instant view switch */}
      <div ref={canvasRef} className={"nc-canvas" + (panning ? " panning" : "") + (tool === "hand" ? " hand" : "") + (canvasIn ? " nc-canvas--in" : "")}
        onAnimationEnd={() => setCanvasIn(false)}
        style={{ backgroundPosition: `${pan.x}px ${pan.y}px`, backgroundSize: `${26 * zoom}px ${26 * zoom}px`, display: view === "node" ? undefined : "none" }}
        onPointerDown={startPan}
        onContextMenu={(e) => {
          /* The add menu belongs to the EMPTY grid. A right-click on a node —
             or on anything inside one: prompt text, a reference card, an
             output tile — is about that node, so it falls through to the
             browser's own menu (copy/paste in the prompt, "save image as" on
             a result) instead of offering to add another node on top of it
             (Kev, 2026-08-22). Testing the target's ancestry rather than
             adding a stopper to each node keeps future node types covered. */
          if ((e.target as HTMLElement).closest(".nc-node")) return;
          e.preventDefault();
          if (rightPan.current.moved) { rightPan.current.moved = false; return; }
          setCtx({ x: e.clientX, y: e.clientY, wx: (e.clientX - sidebarWRef.current - pan.x) / zoom, wy: (e.clientY - pan.y) / zoom });
        }}>
        <div className="nc-world" style={{ transform: "translate(" + pan.x + "px," + pan.y + "px) scale(" + zoom + ")" }}>
          {/* edges */}
          <svg className="nc-edges" width="4000" height="3000">
            {edges.map((e, i) => <path key={i} className="nc-edge" d={path(e.from, e.to, e.trunk)} stroke={e.c} />)}
            {connectLine && <path className="nc-edge" style={{ stroke: connectLine.color, strokeDasharray: "6 6" }} d={path(connectLine.from, connectLine.to, (connectLine.from.x + connectLine.to.x) / 2)} />}
          </svg>

          {/* constellation row frames */}
          {layout.frames.filter((f) => f.count > 0).map((f) => { const pal = palOf(f.cidx); return (
            <div key={f.sig} className={"nc-cframe" + (f.current ? " current" : "") + (selRow === f.sig ? " sel" : "")} style={{ left: f.x, top: f.y, width: f.w, height: 300, background: pal.soft, borderColor: pal.bar }}>
              <div className="nc-clabel" style={{ background: pal.bg, color: pal.ink }} onPointerDown={(e) => startRowDrag(f.sig, e)} title="Drag to move this prompt variant">
                <Icon name="grip" size={13} stroke={2} style={{ opacity: 0.6 }} />
                <span className="nc-clabel-dot" style={{ background: pal.bar }} />
                {f.current ? "Current prompt" : "Prompt variant"} · {f.count} image{f.count === 1 ? "" : "s"}
              </div>
            </div>
          ); })}

          {/* prompt node */}
          <div className={"nc-node nc-prompt" + (sel === "prompt" ? " sel" : "")} style={{ left: prompt.x, top: prompt.y }}
            onPointerDown={() => setSel("prompt")}>
            {dropOn && <div className="nc-dropglow" />}
            <div className="nc-nhead" style={{ background: "color-mix(in oklab, var(--enki-ember) 16%, transparent)" }} onPointerDown={(e) => startNodeDrag("prompt", e)}>
              <span className="nc-ndot" style={{ background: "var(--enki-ember)" }} />
              <EditName className="nc-ribbon-title" value={st.title} onChange={(v) => setSt((p) => ({ ...p, title: v }))} placeholder="Write prompt title…" />
              {/* per-window doc access: jump straight into the doc editor */}
              <button className="nc-nhead-doc" title="Open this prompt in the Doc editor" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); switchView("doc"); }}>
                <Icon name="filetext" size={13} stroke={2} />
              </button>
              <div className={"nc-pm" + (modelFlipUp ? " nc-pm--up" : "")} onPointerDown={(e) => e.stopPropagation()}>
                <button ref={modelTrigRef} className={"nc-pm-trigger" + (modelOpen ? " open" : "")} title="Model used for this prompt — price shown is the production cost"
                  onClick={(e) => { e.stopPropagation(); if (!modelOpen) { const r = modelTrigRef.current?.getBoundingClientRect(); const ph = catalogue.length * 38 + 16; if (r) setModelFlipUp(window.innerHeight - r.bottom < ph + 14 && r.top > ph + 14); } setModelOpen((o) => !o); }}>
                  <span className="nc-pm-name">{selectedModel?.name ?? "Pick a model"}</span>
                  <span className="nc-pm-price">${(selectedModel?.price ?? 0).toFixed(2)}</span>
                  <Icon name="chevronDown" size={13} stroke={2.4} className="nc-pm-chev" />
                </button>
                {modelOpen && (
                  <div className="nc-pm-panel" role="listbox">
                    {catalogue.map((m) => (
                      <button key={m.id} role="option" aria-selected={m.id === st.models[0]}
                        className={"nc-pm-opt" + (m.id === st.models[0] ? " on" : "")}
                        onClick={() => { setSt((p) => ({ ...p, models: [m.id] })); setModelOpen(false); }}>
                        <span className="nc-pm-opt-name">{m.name}</span>
                        <span className="nc-pm-opt-cost"><b>${m.price.toFixed(2)}</b> prod. cost</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="nc-nbody">
              <div className={"nc-refs" + (dropOn ? " drop" : "")}>
                <div className="nc-refs-h">Referenced images{dropOn && <span className="nc-refs-h-drop"> · release to add here</span>}</div>
                <div className="nc-refs-deck" ref={deckRef}
                  /* Grabbing a card must not also arm a canvas pan on the
                     way up — that pan is what kept moving the view after a
                     drop. And the deck itself accepts the drop: opening the
                     gap shifts the target card away from the pointer, so a
                     release often landed on deck background, where — with no
                     handler — the browser cancelled the whole move. Target =
                     the slot the marker is showing (refInsI). */
                  onPointerDown={(e) => { setCtx(null); if (e.button === 0 && !e.ctrlKey && !e.metaKey && !spaceRef.current && tool !== "hand") e.stopPropagation(); }}
                  onDragOver={(e) => { if (refDragI !== null) e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); if (refDrag.current !== null) dropRefAt(refInsI); }}>
                  {refs.map((r, i) => {
                    /* moveRef gives the dragged card the TARGET's position:
                       coming from the left it lands AFTER the target, from
                       the right BEFORE it. The old preview always opened the
                       gap on the left — dragging rightward, it promised a
                       spot one off from where the card would land. Side
                       first, then the gap (and the ember bar) follow it. */
                    /* refInsI is an insertion SLOT: the bar stands left of
                       card refInsI, or right of the last card for the end
                       slot. No-op slots (the dragged card's own position)
                       are filtered to null in onDragOver, so a lit bar
                       always means a real move. */
                    const side = refDragI === null ? null : refInsI === i ? "l" : refInsI === refs.length && i === refs.length - 1 ? "r" : null;
                    const gapW = side === "l" ? 44 + (i === 0 ? 0 : refOverlap) : side === "r" ? 44 : 0; // end slot: the + add button is hidden during a drag, so no neighbour margin
                    return (
                    <div key={r.id} className={"nc-refcard" + (r.userInput ? " ui" : "") + (refDragI === i ? " dragging" : "") + (side ? " over-" + side : "")} draggable
                      style={{ marginLeft: (i === 0 ? 0 : refOverlap) + (side === "l" ? 44 : 0), marginRight: side === "r" ? 44 : 0, zIndex: refDragI === i ? 320 : side ? 240 : i + 1, ...(side ? ({ "--refgap-half": gapW / 2 + "px" } as React.CSSProperties) : null) }}
                      onDragStart={(e) => { e.dataTransfer.setData("text/plain", ""); e.dataTransfer.effectAllowed = "move"; refDrag.current = i; setRefDragI(i); }}
                      /* Midpoint rule, not "take this card's position":
                         nudging the first card slightly right used to light
                         the bar between cards 2 and 3 while the card would
                         really stay put (Kev, 2026-08-22). Left half = the
                         slot before this card, right half = after; the
                         dragged card's own slots resolve to null, so the bar
                         goes dark whenever the release would change nothing. */
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (refDragI === null) return;
                        let ins: number | null;
                        if (refDragI === i) ins = null;
                        else { const rc = e.currentTarget.getBoundingClientRect(); ins = e.clientX > rc.left + rc.width / 2 ? i + 1 : i; if (ins === refDragI || ins === refDragI + 1) ins = null; }
                        if (ins !== refInsI) setRefInsI(ins);
                      }}
                      onDrop={(e) => { e.preventDefault(); if (refDrag.current !== null) dropRefAt(refInsI); }}
                      onDragEnd={() => { refDrag.current = null; setRefDragI(null); setRefInsI(null); }}>
                      {r.img ? (
                        <img src={r.img} alt={"reference " + (i + 1)} draggable={false} title="Click to maximize" onClick={(e) => { e.stopPropagation(); setRefMax(r.img!); }} />
                      ) : (
                        <label className="nc-refcard-up"
                          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (!e.dataTransfer.files?.length && refDrag.current !== null) { dropRefAt(refInsI); return; } onRefFiles(r.id, e.dataTransfer.files); }}
                          onDragOver={(e) => e.preventDefault()}>
                          <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => { onRefFiles(r.id, e.target.files); e.currentTarget.value = ""; }} />
                          <Icon name="imageDrop" size={15} stroke={1.8} />
                        </label>
                      )}
                      <span className="nc-refcard-num">{i + 1}</span>
                      <button className="nc-refcard-x" title="Remove reference" onClick={() => deleteNodeId(r.id)}>×</button>
                      <button className={"nc-refcard-ui" + (r.userInput ? " on" : "")} title={r.userInput ? "User input — the buyer supplies this image" : "Mark as user input (buyer supplies this image)"} onClick={() => toggleRefUserInput(r.id)} role="checkbox" aria-checked={!!r.userInput}>
                        <span className="nc-refcard-ui-box">{r.userInput && <Icon name="check" size={8} stroke={4} />}</span>
                        User input
                      </button>
                    </div>
                  ); })}
                  <button className={"nc-refadd" + (refDragI !== null ? " nc-refadd--drag" : "")} style={{ marginLeft: REF_GAP }} title="Upload reference images" onClick={() => refUploadRef.current?.click()}>+</button>
                  <input ref={refUploadRef} type="file" accept={modelLimits.accept} multiple style={{ display: "none" }} onChange={(e) => { addRefsFromFiles(e.target.files); e.currentTarget.value = ""; }} />
                </div>
              </div>
              <div className="nc-pbox">
                <div className="nc-pov" ref={ovRef}>
                  {(() => {
                    const parts = st.body.split(TOKEN_RE);
                    let charAt = 0;
                    return parts.map((part, i) => {
                      const start = charAt;
                      charAt += part.length;
                      if (!/^\[[^\]\n]+\]$/.test(part)) return <span key={i}>{part}</span>;
                      const name = part.slice(1, -1);
                      const ref = isRefTok(part);
                      const refN = ref ? parseInt(part.replace(/\D/g, ""), 10) : 0;
                      // Orphaned token (variable was deleted) → the raw
                      // [bracketed] text comes back, no chip.
                      const alive = ref ? refN >= 1 && refN <= liveRefCount : liveTokNames.has(name);
                      if (!alive) return <span key={i}>{part}</span>;
                      const c = colorForTok(part);
                      /* The turquoise ring means "the buyer supplies this",
                         and a reference image can be user input exactly like a
                         text variable can — its card already shows the ring via
                         .nc-refcard.ui. The token in the SENTENCE never did,
                         because isPub only ever consulted pubNames, which holds
                         text-variable names (Kev, 2026-08-19). Ref tokens are
                         numbered by POSITION — deleting or reordering renumbers
                         them — so token N is refs[N-1]. */
                      const isPub = ref ? !!refs[refN - 1]?.userInput : pubNames.has(name);
                      const tokStyle = {
                        "--tok-bg": c.bg,
                        "--tok-ring": isPub
                          ? "inset 0 0 0 1px " + c.border + ", 0 0 0 2px var(--enki-turq)"
                          : "inset 0 0 0 1px " + c.border,
                        color: c.text,
                      } as React.CSSProperties;
                      /* Dragging a card in the deck lights up ITS token in the
                         sentence — same ember outline as a chip being dragged
                         (nc-tok-src), so "the thing in motion" has one colour
                         everywhere (Kev, 2026-08-22). Ref tokens are numbered
                         by position: card refDragI = token refDragI+1. */
                      return (
                        <span key={i} className={"nc-tok" + (armed === part ? " armed" : "") + (isPub ? " pub" : "") + (ref && refDragI !== null && refN === refDragI + 1 ? " nc-tok-src" : "")}
                          style={tokStyle}
                          title={ref ? "Drag to move this image reference in the text" : "Click to edit · drag to move"}
                          onPointerDown={(e) => beginTokPointer(part, start, e)}
                        >
                          {/* Brackets stay in the DOM (glyph layout must match the
                              textarea exactly) but are painted invisible. */}
                          <span className="nc-tok-br">[</span>{name}<span className="nc-tok-br">]</span>
                        </span>
                      );
                    });
                  })()}{"\n"}
                </div>
                <textarea ref={taRef} className="nc-pta" value={st.body} style={{ minHeight: boxH.current }}
                  placeholder="Describe the image you want to sell as a prompt…"
                  onChange={(e) => onBodyChange(e.target.value)}
                  onMouseUp={schedulePill}
                  onKeyUp={(e) => { if (e.shiftKey || e.key === "Shift") schedulePill({}); }}
                  onFocus={pushHist} onKeyDown={onPromptKey}
                  onScroll={() => { if (ovRef.current && taRef.current) ovRef.current.scrollTop = taRef.current.scrollTop; }}
                  onPointerDown={(e) => e.stopPropagation()} spellCheck={false} />
                {selPill && (
                  <button className="ncd-pill" style={{ left: selPill.x, top: selPill.y }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.preventDefault() /* keep the textarea selection */}
                    onClick={addVariableFromSel}>+ Variable</button>
                )}
              </div>
              <div className="nc-addrow nc-addrow--gen">
                <div className="nc-genopts">
                  <NcSelect icon={<span style={{ color: "var(--enki-ink-3)", display: "flex" }}><RatioRect ratio={st.ratio} size={14} /></span>} value={st.ratio} width={88} grow={false} title="Aspect ratio · does not affect grouping"
                    options={ncRatios(selectedModel).map((r) => ({ value: r, label: r, icon: <RatioRect ratio={r} size={15} /> }))} onChange={(v) => setSt((p) => ({ ...p, ratio: v }))} />
                  {qualityTiers.length > 0 && (
                    <NcSelect icon={<Maximize2 size={14} style={{ color: "var(--enki-ink-3)" }} />} value={qualityTiers.includes(st.quality) ? st.quality : qualityTiers[qualityTiers.length - 1]} width={72} grow={false} title="Resolution · does not affect grouping"
                      options={qualityTiers.map((q) => { const p = tierPrice(st.mode === "premium" ? selectedModel : undefined, q); return { value: q, label: q, sub: p != null ? "$" + p.toFixed(2) : undefined }; })} onChange={(v) => setSt((p) => ({ ...p, quality: v }))} />
                  )}
                  {/* Model-specific settings belong to the PROMPT, so they are
                      set where the prompt is written (Kev, 2026-08-19) — not
                      discovered later on the generate panel. Only models that
                      honour the lever show it.

                      An NcSelect like its neighbours, not the shared
                      QualitySelect: that one is a native <select>, so its
                      trigger could never match this row and its dropdown was
                      the browser's own washed-out popup (Kev's screenshot).

                      No price marks on the options. Quality moves OUR provider
                      cost (~35x spread on OpenAI), but the quote and the
                      intent do not read the field, so what Kev and his buyers
                      are CHARGED is identical on every setting — verified
                      2026-08-19, neither schema knows `quality`. Dollar signs
                      here claimed a difference that does not exist for the
                      person looking at them. */}
                  {supportsQuality && (
                    <NcSelect
                      icon={<Gem size={13} style={{ color: "var(--enki-ink-3)" }} />}
                      value={quality}
                      width={84}
                      grow={false}
                      title="Quality — how much detail GPT-Image-2 renders. Your price is the same on every setting."
                      options={[
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Mid" },
                        { value: "high", label: "High" },
                      ]}
                      onChange={(v) => setQuality(v as Quality)}
                    />
                  )}
                </div>
                {/* Dice + Generate as one cluster: the row is space-between,
                    so a bare sibling would strand the dice mid-row. */}
                <div style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <DiceButton
                    // Node id as the dice id — renames can't mis-key the reply.
                    // Blank-named nodes are skipped: one nameless var would
                    // fail validation and kill the whole roll otherwise.
                    variables={texts.filter((t) => t.name.trim()).map((t) => (t.kind === "bool"
                      ? { id: t.id, name: t.name, type: "checkbox", description: (t.str || "").trim() || undefined }
                      : { id: t.id, name: t.name, type: "text" }))}
                    context={st.body.trim() || undefined}
                    headers={sessionAuthHeaders()}
                    onValues={applyDiceValues}
                  />
                  <button className={"nc-prompt-genbtn nc-prompt-genbtn--stack" + (canGenerate ? "" : " disabled")} title={canGenerate ? "Generate one image at " + st.quality : !selectedModel ? "Pick a model first" : "Write a prompt first"} onClick={() => spawnOutput()}>
                    {/* zap, like every Generate — sparkles is Release's icon.
                        The icon sits BESIDE the Generate/price block, so the
                        flex row centers it against both lines, not just the
                        first (Kev, 2026-08-22). */}
                    <Icon name="zap" size={16} stroke={2.2} fill={canGenerate ? "var(--cta-ink)" : "none"} />
                    <span className="nc-genbtn-txt">
                      <span className="nc-genbtn-top">Generate</span>
                      <span className="nc-genbtn-sub">${perImage.toFixed(2)}</span>
                    </span>
                  </button>
                </div>
              </div>
            </div>
            {/* ports — text input (left) + generated-images output (right); reference images are an in-prompt deck */}
            <span className="nc-port nc-port--io" style={{ left: -7.5, top: 115.5, background: TEXT_PALETTE[0].dot }}
              title="Text inputs · drag out (or double-click) to add one"
              onPointerDown={(e) => startConnect("text", e)} onDoubleClick={(e) => portDbl("text", e)} />
            <span className="nc-port-lab nc-port-lab--in" style={{ top: 116 }}>text</span>
            <button className="nc-port-add" style={{ left: -28, top: 115 }} title="Add a text input node"
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); addText(); }}><Icon name="plus" size={11} stroke={2.6} /></button>
            {/* Embed a prompt or workflow as a node (Kev, 2026-09-05). */}
            <span className="nc-port nc-port--io" style={{ left: -7.5, top: 155.5, background: "var(--enki-turq)" }} title="Workflows: embedded prompts speak here" />
            <span className="nc-port-lab nc-port-lab--in" style={{ top: 156 }}>workflow</span>
            <button className="nc-port-add" style={{ left: -28, top: 155 }} title="Insert a prompt or workflow as a node"
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setWfPickerOpen(true); }}><Icon name="plus" size={11} stroke={2.6} /></button>
            <span className="nc-port nc-port--io" style={{ right: -7.5, top: 115.5, background: "var(--enki-ember)" }}
              title="Generated images output · drag out (or double-click) to render"
              onPointerDown={(e) => startConnect("out", e)} onDoubleClick={(e) => portDbl("out", e)} />
            <span className="nc-port-lab nc-port-lab--out" style={{ top: 110 }}>Output<br />Images</span>
            <button className="nc-port-add" style={{ right: -28, top: 115 }}
              title="Add an output image node (Generate also creates one automatically)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); addOutput(); }}>
              <Icon name="plus" size={11} stroke={2.6} /></button>
          </div>

          {wfPickerOpen && <WorkflowPicker onPick={addWorkflow} onClose={() => setWfPickerOpen(false)} />}

          {/* text nodes */}
          {texts.map((t) => { const c = textColor[t.name] || TEXT_PALETTE[0]; return (
            <div key={t.id} data-nid={t.id} className={"nc-node nc-text" + (sel === t.id || selSet.has(t.id) ? " sel" : "")} style={{ left: t.x, top: t.y, ...(t.pub ? { borderColor: "var(--enki-turq)", boxShadow: "0 0 0 2.5px var(--enki-turq), 0 6px 22px rgba(0,0,0,.12)" } : null) }} onPointerDown={(e) => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); toggleSel(t.id); } else setSel(t.id); }}>
              <div className="nc-nhead" style={{ background: `color-mix(in oklab, ${c.dot} 15%, transparent)` }} onPointerDown={(e) => startNodeDrag(t.id, e)}>
                <span className="nc-ndot" style={{ background: c.dot }} />
                <EditName className="nc-ntitle" value={t.name} onChange={(v) => renameText(t.id, v)} placeholder={t.name} title={`Double-click to change the name of "${t.name}"`} />
                <button className="nc-ntrash" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); deleteNodeId(t.id); }}><Icon name="trash" size={14} stroke={2} /></button>
              </div>
              <div className="nc-nbody">
                <div className="nc-vtoggle">
                  <button className={t.kind === "text" ? "active" : ""} title="Text — the user types their own words" onClick={() => setTextKind(t.id, "text")}>Text</button>
                  <button className={t.kind === "bool" ? "active" : ""} title="Checkbox — the user just toggles this detail on or off (no typing)" onClick={() => setTextKind(t.id, "bool")}>Checkbox</button>
                </div>
                {t.kind === "text" ? (
                  <textarea className="nc-vin nc-varea" placeholder={"Default value · e.g. " + t.name} value={t.value} onChange={(e) => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === t.id ? { ...n, value: e.target.value } : n)) }))} onPointerDown={(e) => e.stopPropagation()} spellCheck={false} />
                ) : (
                  <>
                    <textarea className="nc-vin nc-varea" placeholder={"Prompt added when checked · e.g. " + t.name} value={t.str || ""} onChange={(e) => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === t.id ? { ...n, str: e.target.value } : n)) }))} onPointerDown={(e) => e.stopPropagation()} spellCheck={false} />
                    <label className="nc-chk" title="Default state of the checkbox the user will see" onClick={() => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === t.id ? { ...n, value: n.value === "on" || n.value === "Yes" ? "off" : "on" } : n)) }))}>
                      <span className={"nc-chk-box" + (t.value === "on" || t.value === "Yes" ? " on" : "")}>{(t.value === "on" || t.value === "Yes") && <Icon name="check" size={11} stroke={3} />}</span> Checked by default
                    </label>
                  </>
                )}
                {/* Only TEXT variables can be public — checkbox vars are helper vars. */}
                {t.kind === "text" && <label className="nc-chk" onClick={() => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === t.id ? { ...n, pub: !n.pub } : n)) }))}>
                  <span className={"nc-chk-box" + (t.pub ? " on" : "")}>{t.pub && <Icon name="check" size={11} stroke={3} />}</span> Publicly visible (user input)
                </label>}
              </div>
              <span className="nc-port" style={{ right: -7.5, top: 22.5, background: c.dot }} />
            </div>
          ); })}

          {/* workflow nodes: embedded prompts; a compact card, unfold to see inside */}
          {st.nodes.filter((n) => n.type === "workflow").map((w) => (
            <div key={w.id} data-nid={w.id} className={"nc-node nc-workflow" + (sel === w.id || selSet.has(w.id) ? " sel" : "") + (w.open ? " open" : "")} style={{ left: w.x, top: w.y }}
              onPointerDown={(e) => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); toggleSel(w.id); } else setSel(w.id); }}>
              <div className="nc-nhead nc-workflow-head" onPointerDown={(e) => startNodeDrag(w.id, e)}>
                <Icon name="link" size={13} stroke={2} />
                <span className="nc-ntitle" title={w.wf?.title}>{w.wf?.title}</span>
                <button className="nc-ntrash" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); deleteNodeId(w.id); }}><Icon name="trash" size={14} stroke={2} /></button>
              </div>
              <div className="nc-workflow-meta">
                <span>{w.wf?.author ? `by ${w.wf.author}` : "from your library"}</span>
                <span>{w.wf?.vars.length ?? 0} input{(w.wf?.vars.length ?? 0) === 1 ? "" : "s"} · {w.wf?.price ? `$${w.wf.price.toFixed(2)}/use` : "free"}</span>
              </div>
              <button type="button" className="nc-workflow-toggle" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); toggleWorkflowOpen(w.id); }} aria-expanded={!!w.open}>
                <Icon name="expand" size={12} stroke={2.2} /> {w.open ? "Hide inside" : "Show inside"}
              </button>
              {w.open && (
                <div className="nc-workflow-inside" title="Read-only: another artist's work. Its inputs are the text nodes wired into this card.">
                  {(w.wf?.text ?? "").split(TOKEN_RE).map((part, i) => TOKEN_RE.test(part) && !isRefTok(part)
                    ? <span key={i} className="nc-workflow-var">{part}</span>
                    : <span key={i}>{part}</span>)}
                </div>
              )}
              <span className="nc-port nc-port--io nc-workflow-out" title="Speaks into the prompt at its {{wf}} marker" />
            </div>
          ))}

          {/* output nodes */}
          {outs.map((o, oi) => {
            const pos = outPos(o); if (!pos) return null;
            const pal = palOf((st.cons.find((c) => c.sig === o.sig) || { cidx: 0 }).cidx || 0);
            const exp = expandedOuts[o.id];
            return (
              <div key={o.id} data-nid={o.id} className={"nc-node nc-out" + (sel === o.id || selSet.has(o.id) ? " sel" : "") + (o.picked ? " picked" : "")} style={{ left: pos.x, top: pos.y, borderColor: o.picked ? undefined : pal.bar }} onPointerDown={(e) => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); toggleSel(o.id); } else setSel(o.id); }} onDoubleClick={(e) => { e.stopPropagation(); addOutput(); }}>
                {pulseId === o.id && <span className="nc-pulse" style={{ color: pal.bar }}><Icon name="arrowRight" size={20} stroke={3} /></span>}
                <div className="nc-nhead" style={{ background: `color-mix(in oklab, ${pal.bar} 16%, transparent)` }} onPointerDown={(e) => startOutDrag(o.id, e)}>
                  <span className="nc-ndot" style={{ background: pal.bar }} />
                  <span className="nc-ntitle" style={{ color: "var(--enki-ink)" }}>Output Image {oi + 1}</span>
                  {o.img && <button className={"nc-out-pick" + (o.picked ? " on" : "")} title={o.picked ? "Marked for public release — will be shown publicly. Click to unmark." : "Mark for public release (shown publicly). Only one group can be released."} onPointerDown={(e) => e.stopPropagation()} onClick={() => togglePick(o.id)}><Icon name="star" size={14} stroke={2} fill={o.picked ? "currentColor" : "none"} /></button>}
                  {o.img && <button className="nc-out-pushbtn" title="Send these values to the editor on the left" onPointerDown={(e) => e.stopPropagation()} onClick={() => setConfirmPush(o.id)}><Icon name="chevronLeft" size={15} stroke={2.4} /></button>}
                  <button className="nc-ntrash" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); deleteNodeId(o.id); }}><Icon name="trash" size={14} stroke={2} /></button>
                </div>
                <div className="nc-nbody">
                  {o.img ? (
                    <img className="nc-out-img" src={o.img} alt="output" draggable={false} style={{ cursor: "zoom-in" }}
                      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openLightbox(o.id); }} />
                  ) : o.status === "loading" ? (
                    <div className="nc-out-empty"><span className="ek-spinner" /> generating…</div>
                  ) : (
                    <div className="nc-out-empty nc-out-empty--click" title="Click to load this image's variables & prompt into the editor on the left"
                      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); pushValuesLeft(o.id); }}>
                      <Icon name="image" size={20} stroke={1.6} /> empty<span className="nc-out-empty-hint">show composition ←</span>
                    </div>
                  )}
                  {o.img && texts.length > 0 && (
                    <>
                      <button className="nc-out-toggle" onPointerDown={(e) => e.stopPropagation()} onClick={() => toggleExpand(o.id)}>
                        <Icon name="chevronDown" size={13} stroke={2.4} style={{ transform: exp ? "rotate(180deg)" : "none" }} /> {texts.length} variable value{texts.length === 1 ? "" : "s"}
                      </button>
                      {exp && (
                        <div className="nc-out-vars">
                          {texts.map((t) => {
                            const c = textColor[t.name] || TEXT_PALETTE[0];
                            const tok = "[" + t.name + "]";
                            const raw = (o.vals || {})[tok];
                            const val = raw !== undefined ? raw : t.value;
                            const isBool = t.kind === "bool";
                            const disp = isBool ? (val === "on" ? "On" : "Off") : (val || "—");
                            const ekey = o.id + ":" + tok;
                            const open = outEdit === ekey;
                            if (open)
                              return isBool ? (
                                <div className="nc-out-var nc-out-var--edit" key={t.id} style={{ background: c.bg, boxShadow: "inset 0 0 0 1px " + c.border }} onPointerDown={(e) => e.stopPropagation()}>
                                  <span className="nc-out-var-k" style={{ color: c.text }}>{t.name}</span>
                                  <button type="button" className={"ce-vex-knob" + (val === "on" ? " on" : "")} style={{ background: val === "on" ? "var(--enki-ember)" : "var(--enki-rule)" }} onClick={() => setOutVal(o.id, tok, val === "on" ? "off" : "on")} />
                                  <span style={{ fontSize: 11 }}>{disp}</span>
                                  <button className="nc-out-var-done" onClick={() => setOutEdit(null)}><Icon name="check" size={12} stroke={2.6} /></button>
                                </div>
                              ) : (
                                <div className="nc-out-var nc-out-var--edit" key={t.id} style={{ background: c.bg, boxShadow: "inset 0 0 0 1px " + c.border }} onPointerDown={(e) => e.stopPropagation()}>
                                  <span className="nc-out-var-k" style={{ color: c.text }}>{t.name}</span>
                                  <textarea className="nc-out-var-input" rows={2} autoFocus value={val} onChange={(e) => setOutVal(o.id, tok, e.target.value)} onBlur={() => setOutEdit(null)} />
                                </div>
                              );
                            return (
                              <button className="nc-out-var" key={t.id} title={"Click to edit · " + t.name + ": " + disp} style={{ background: c.bg, boxShadow: "inset 0 0 0 1px " + c.border }} onPointerDown={(e) => e.stopPropagation()} onClick={() => setOutEdit(ekey)}>
                                <span className="nc-out-var-k" style={{ color: c.text }}>{t.name}</span>
                                <span className="nc-out-var-v">{disp}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {confirmPush === o.id && (
                  <div className="nc-confirm" onPointerDown={(e) => e.stopPropagation()}>
                    <div className="nc-confirm-t">Overwrite the variable values in the left-hand editor with this image&apos;s values?</div>
                    <div className="nc-confirm-actions">
                      <button className="nc-confirm-no" onClick={() => setConfirmPush(null)}>Cancel</button>
                      <button className="nc-confirm-yes" onClick={() => pushValuesLeft(o.id)}>Overwrite</button>
                    </div>
                  </div>
                )}
                <span className="nc-port" style={{ left: -7.5, top: 22.5, background: pal.bar }} />
              </div>
            );
          })}
        </div>
      </div>

      {/* edge arrows — point to image groups that are scrolled off-screen;
          click to glide the view onto that group */}
      {view === "node" && (() => {
        const W = vp.w - sidebarW, H = vp.h, M = 32;
        return layout.frames.filter((f) => f.count > 0).map((f) => {
          const scx = (f.x + f.w / 2) * zoom + pan.x, scy = (f.y + 150) * zoom + pan.y;
          if (scx >= 0 && scx <= W && scy >= 0 && scy <= H) return null; // on-screen
          const cx = W / 2, cy = H / 2; const dx = scx - cx, dy = scy - cy;
          if (dx === 0 && dy === 0) return null;
          const s = Math.min(dx !== 0 ? (W / 2 - M) / Math.abs(dx) : Infinity, dy !== 0 ? (H / 2 - M) / Math.abs(dy) : Infinity);
          const ex = cx + dx * s, ey = cy + dy * s;
          const deg = Math.atan2(dy, dx) * 180 / Math.PI;
          const pal = palOf(f.cidx);
          return (
            <button key={f.sig} className="nc-edgearrow" style={{ left: ex, top: ey, color: pal.bar }}
              title="Jump to this image group" onClick={() => focusFrame(f.x, f.w, f.y)}>
              <span className="nc-edgearrow-ico" style={{ transform: "rotate(" + deg + "deg)" }}><Icon name="arrowRight" size={20} stroke={2.6} /></span>
            </button>
          );
        });
      })()}

      {/* tool group — top-right; SAME bar in both views (undo/redo/menu), the
          canvas-only zoom + tool cluster hides while the doc is up */}
      <div className="nc-toolbar">
        <button className="nc-iconbtn" onClick={undo} disabled={!hist.current.past.length} title="Undo"><Icon name="undo" size={15} stroke={2} /></button>
        <button className="nc-iconbtn" onClick={redo} disabled={!hist.current.future.length} title="Redo"><Icon name="redo" size={15} stroke={2} /></button>
        {view === "node" && <>
        <span className="nc-rb-div" />
        <button className="nc-iconbtn" onClick={() => tweenZoom(zoomRef.current / 1.25)} disabled={zoom <= 0.3} title="Zoom out">−</button>
        {zoomEditing ? (
          <input className="nc-zoomval nc-zoomedit" autoFocus value={zoomInput} inputMode="numeric"
            onChange={(e) => setZoomInput(e.target.value.replace(/[^0-9]/g, ""))}
            onBlur={commitZoomInput}
            onKeyDown={(e) => { if (e.key === "Enter") commitZoomInput(); else if (e.key === "Escape") setZoomEditing(false); }} />
        ) : (
          <span className="nc-zoomval" title="Click to type a zoom level" onClick={() => { setZoomInput(String(Math.round(zoom * 100))); setZoomEditing(true); }}>{Math.round(zoom * 100)}%</span>
        )}
        <button className="nc-iconbtn" onClick={() => tweenZoom(zoomRef.current * 1.25)} disabled={zoom >= 1} title="Zoom in">+</button>
        </>}
        {mockMode && <button className="nc-mock-chip" title="Mock-up mode is on — Generate produces instant placeholder images. Click to turn off." onClick={() => setMockMode(false)}><Icon name="wand" size={12} stroke={2.2} /> Mock-up</button>}
        {view === "node" && <>
        <span className="nc-rb-div" />
        <div className="nc-toolseg" role="group" aria-label="Canvas tool">
          <button className={tool === "select" ? "on" : ""} title="Select tool — left-drag moves the view, Ctrl+left-drag marquee-selects, right-drag also moves" onClick={() => setTool("select")}><Icon name="cursor" size={15} stroke={2} /></button>
          <button className={tool === "hand" ? "on" : ""} title="Hand tool — drag anywhere to move the view" onClick={() => setTool("hand")}><Icon name="hand" size={15} stroke={2} /></button>
        </div>
        </>}
        <span className="nc-rb-div" />
        <div className="nc-menu-wrap">
          <button className={"nc-iconbtn" + (menuOpen ? " on" : "")} onClick={() => setMenuOpen((o) => !o)} title="Menu" aria-haspopup="menu" aria-expanded={menuOpen}><Icon name="menu" size={17} stroke={2} /></button>
          {menuOpen && (
            <>
              <div className="nc-menu-scrim" onPointerDown={() => setMenuOpen(false)} />
              <div className="nc-menu" role="menu">
                <button className="nc-menu-item" role="menuitem" onClick={() => { setMenuOpen(false); switchView(view === "doc" ? "node" : "doc"); }}>
                  <Icon name={view === "doc" ? "grid" : "filetext"} size={15} stroke={2} /> {view === "doc" ? "Node view" : "Doc view"}
                </button>
                <div className="nc-menu-sep" />
                <button className={"nc-menu-item nc-menu-toggle" + (mockMode ? " on" : "")} role="menuitemcheckbox" aria-checked={mockMode} onClick={() => setMockMode((v) => !v)}>
                  <Icon name="wand" size={15} stroke={2} /> <span className="nc-menu-grow">Mock-up mode</span>
                  <span className="nc-menu-state">{mockMode ? "On" : "Off"}</span>
                </button>
                <div className="nc-menu-sep" />
                <button className="nc-menu-item" role="menuitem" onClick={() => void saveToLibrary()}><Icon name="bookmark" size={15} stroke={2} /> Save to my library</button>
                <button className="nc-menu-item" role="menuitem" onClick={exportPrompt}><Icon name="download" size={15} stroke={2} /> Export prompt as JSON</button>
                <button className="nc-menu-item" role="menuitem" onClick={importPrompt}><Icon name="upload" size={15} stroke={2} /> Import prompt JSON</button>
                <div className="nc-menu-sep" />
                <button className="nc-menu-item" role="menuitem" onClick={() => { setMenuOpen(false); requestClose(); }}><Icon name="x" size={15} stroke={2} /> Close editor</button>
              </div>
            </>
          )}
        </div>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={onImportFile} />
      </div>

      {/* Generate panel — flush to the top-right frame edge, in line with the
          toolbar. Node view only: the doc view carries its own generate bar +
          results/release column. */}
      {view === "node" && <div className="nc-gp" role="dialog">
        <div className="nc-gp-row">
          <span className="nc-gp-lab">{imgCount} image{imgCount > 1 ? "s" : ""}</span>
          <span className="nc-gp-cost">${shownCost.toFixed(2)}</span>
        </div>
        <div className="nc-gp-gen" style={{ marginBottom: 6 }}>
          <BoostToggle boost={boost} onChange={setBoost} available={!!selectedModel?.boostAvailable} />
        </div>
        <div className="nc-gp-gen">
          <button className="nc-gp-btn" onClick={() => runGenerate(true)} title="Autofill variables & generate"><Icon name="wand" size={12} stroke={2} /> Autofill</button>
          {/* The primary action wears the CTA colour and carries the price of
              the ENTIRE run — the workflow total (every image at the chosen
              model/resolution, boost included), the same number as the
              header row. "Pay & Gen" named the mechanics; the price itself
              says it costs money (Kev, 2026-08-22). */}
          <button className="nc-gp-btn nc-gp-btn--go" onClick={() => runGenerate(false)} title={"Generate " + imgCount + " image" + (imgCount > 1 ? "s" : "") + " — total for the whole run"}><Icon name="zap" size={12} stroke={2} fill="currentColor" /> Generate<span className="nc-gp-go-price">${shownCost.toFixed(2)}</span></button>
        </div>
        <div className="nc-gp-rel">
          <div className="nc-gp-relh"><Icon name="star" size={10} stroke={2} fill="currentColor" /> To release{pickedOuts.length ? " · " + pickedOuts.length : ""}</div>
          {pickedOuts.length ? (() => {
            const pSig = pickedOuts[0].sig; const pCon = (st.cons || []).find((c) => c.sig === pSig);
            const pPal = palOf(pCon?.cidx ?? 0); const pLabel = pSig === curSig ? "Current prompt" : "Prompt variant";
            const pFrame = layout.frames.find((f) => f.sig === pSig);
            return (
              <>
                <button className="nc-gp-group" style={{ background: pPal.bg, color: pPal.ink }} title="Focus this group in the editor"
                  onClick={() => { if (pFrame) focusFrame(pFrame.x, pFrame.w, pFrame.y); }}>
                  <span className="nc-release-gdot" style={{ background: pPal.bar }} /> {pLabel} · {pickedOuts.length} <Icon name="arrowRight" size={10} stroke={2.4} />
                </button>
                <div className="nc-gp-strip">
                  {pickedOuts.map((o) => (
                    <button key={o.id} className="nc-gp-thumb" style={{ borderColor: pPal.bar }} title="Click to preview" onClick={() => setRefMax(o.img!)}>
                      <img src={o.img || undefined} alt="" draggable={false} />
                    </button>
                  ))}
                </div>
              </>
            );
          })() : (
            <div className="nc-gp-relhint">Tap <b>★</b> on outputs to publish them publicly · one group only.</div>
          )}
        </div>
        <button className={"nc-gp-release" + (canRelease ? "" : " disabled")} disabled={!canRelease} onClick={release}>
          <Icon name="sparkles" size={12} stroke={2} fill="var(--cta-ink)" /> Release{pickedOuts.length ? " " + pickedOuts.length : ""}
        </button>
        {!canRelease && <div className="nc-gp-need">{st.mode === "free" ? "Pick ≥ 1 image" : "Pick ≥ 4 (" + pickedOuts.length + "/4)"}</div>}
      </div>}

      {/* prompt-settings ribbon (top-left) — the SHARED header: identical in
          doc and node view, incl. the view switch itself */}
      <div className="nc-ribbon">
        <div className="nc-rb-cell">
          <span className="nc-rb-lab">Title</span>
          <input className="nc-rb-input" value={st.title} onChange={(e) => setSt((p) => ({ ...p, title: e.target.value }))} placeholder="Write prompt title…" />
        </div>
        <div className="nc-rb-cell">
          <span className="nc-rb-lab">View</span>
          <div className="ce-seg nc-viewseg" role="group" aria-label="Editor view">
            <button type="button" className={view === "doc" ? "active" : ""} title="Doc view — edit your prompt like a document" onClick={() => switchView("doc")}><Icon name="filetext" size={12} stroke={2.2} /> Doc</button>
            <button type="button" className={view === "node" ? "active" : ""} title="Node view — the full prompt graph on a canvas" onClick={() => switchView("node")}><Icon name="grid" size={12} stroke={2.2} /> Nodes</button>
          </div>
        </div>
        <div className="nc-rb-cell">
          <span className="nc-rb-lab">Prompt type</span>
          <div className="ce-seg">
            <button type="button" className={st.mode === "free" ? "active" : ""} title="Free prompt — anyone can run it at no cost. You publish 1 example image when releasing." onClick={() => setSt((p) => ({ ...p, mode: "free" }))}>Free</button>
            <button type="button" className={st.mode === "premium" ? "active" : ""} title="Premium prompt — buyers pay to unlock it; you earn per sale. You publish 4 example images when releasing." onClick={() => setSt((p) => ({ ...p, mode: "premium" }))}>Premium</button>
          </div>
        </div>
        <div className="nc-rb-cell">
          <span className="nc-rb-lab">Category</span>
          <NcSelect value={st.cat} width={138} title="Prompt category"
            options={[{ value: "", label: "Any" }, ...CATEGORIES.map((c) => ({ value: c, label: c }))]}
            onChange={(v) => setSt((p) => ({ ...p, cat: v }))} />
        </div>
        <div className="nc-rb-cell" style={{ opacity: st.mode === "premium" ? 1 : 0.35, transition: "opacity .15s" }}>
          <span className="nc-rb-lab">Price · render</span>
          <div className="nc-rb-price" title={st.mode === "premium" ? "What a buyer pays you per render" : "Price applies in Premium mode only"}>
            <span>$</span>
            {/* Typing happens in the input; STEPPING shows the digit view,
                where only the digits that changed roll (Kev, 2026-08-19:
                "only per digit, not the entire number"). An <input> cannot
                animate part of its own value, so the two states are two
                renderings of one number: click the digits to type, blur to
                get the rolling view back. */}
            {priceEdit ? (
              <input type="number" step={0.01} min={0} value={st.price} disabled={st.mode !== "premium"} autoFocus
                onBlur={() => setPriceEdit(false)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setPriceEdit(false); }}
                onChange={(e) => setSt((p) => ({ ...p, price: Math.max(0, parseFloat(e.target.value) || 0) }))} />
            ) : (
              <button type="button" className="nc-price-view" disabled={st.mode !== "premium"}
                title="Click to type a price" onClick={() => setPriceEdit(true)}>
                {(() => {
                  const cur = st.price.toFixed(2);
                  const prev = prevPriceRef.current.toFixed(2).padStart(cur.length, " ");
                  return cur.split("").map((ch, i) => (
                    <span key={i + "-" + ch} className={priceRoll && ch !== prev[i] ? "nc-price-roll-" + priceRoll : undefined}
                      onAnimationEnd={() => setPriceRoll(null)}>{ch}</span>
                  ));
                })()}
              </button>
            )}
            {/* The native spinner is hidden in CSS — it is the browser's
                widget and matches nothing here (Kev's screenshot). These two
                are ordinary Enki buttons, and stepping plays a quick roll of
                the number in the step's direction. */}
            <span className="nc-price-steps" aria-hidden={st.mode !== "premium"}>
              <button type="button" tabIndex={-1} disabled={st.mode !== "premium"} title="+ $0.01"
                onClick={() => { prevPriceRef.current = st.price; setPriceRoll("up"); setSt((p) => ({ ...p, price: Math.round((p.price + 0.01) * 100) / 100 })); }}>
                <Icon name="chevronUp" size={10} stroke={2.6} />
              </button>
              <button type="button" tabIndex={-1} disabled={st.mode !== "premium"} title="− $0.01"
                onClick={() => { prevPriceRef.current = st.price; setPriceRoll("down"); setSt((p) => ({ ...p, price: Math.max(0, Math.round((p.price - 0.01) * 100) / 100) })); }}>
                <Icon name="chevronDown" size={10} stroke={2.6} />
              </button>
            </span>
          </div>
        </div>
      </div>

      {/* doc-style editing view (shares st with the canvas 1:1) */}
      {view === "doc" && (
        <DocView api={{
          st, texts, refs, outs, cons: st.cons, curSig, liveTokNames, liveRefCount, pubNames,
          colorForTok, palOf, perImage, canGenerate, pickedOuts, releaseMin, canRelease,
          modelAccept: modelLimits.accept,
          onBodyChange, pushHist, addText, patchText, setTextKind, renameText, deleteNodeId,
          addRefsFromFiles, onRefFiles, toggleRefUserInput, setRefMax,
          spawnOutput, togglePick, release, openLightbox,
          setModel: (id) => setSt((p) => ({ ...p, models: [id] })),
          setRatio: (v) => setSt((p) => ({ ...p, ratio: v })),
          setQuality: (v) => setSt((p) => ({ ...p, quality: v })),
          gptQuality: quality,
          setGptQuality: (v) => setQuality(v as Quality),
          supportsGptQuality: supportsQuality,
          onToast, switchView,
        }} />
      )}

      {/* context menu */}
      {ctx && (
        <div className="nc-ctx" style={{ left: Math.min(ctx.x, window.innerWidth - 210), top: Math.min(ctx.y, window.innerHeight - 170) }} onPointerDown={(e) => e.stopPropagation()}>
          <button className="nc-ctx-item" onClick={() => ctxAdd("text")}><span className="nc-ctx-ico" style={{ background: TEXT_PALETTE[0].dot }}><Icon name="type" size={15} stroke={2} /></span> Add Text Input</button>
          <button className="nc-ctx-item" onClick={() => ctxAdd("output")}><span className="nc-ctx-ico" style={{ background: "var(--enki-ember)" }}><Icon name="image" size={15} stroke={2} /></span> Add Output Slot</button>
        </div>
      )}

      {marquee && (
        <div className="nc-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />
      )}

      {view !== "node" ? null : tipOpen ? (
        <div className="nc-help">
          <button className="nc-help-x" onClick={() => setTipOpen(false)} title="Hide tip" aria-label="Hide tip">‹</button>
          <b>Tip:</b> right-click the canvas to add nodes · drag images onto the prompt · press <b>Delete</b> on a colored token to remove its variable.
        </div>
      ) : (
        <button className="nc-help-q" onClick={() => setTipOpen(true)} title="Show tip" aria-label="Show tip">?</button>
      )}

      {/* image lightbox — maximize an output, browse its group (←/→) and switch
          between image groups (↑/↓) via the vertical rail on the left */}
      {lbOpen && lbGroups.length > 0 && (() => {
        const g = Math.min(lbG, lbGroups.length - 1);
        const grp = lbGroups[g];
        const i = Math.min(lbI, grp.imgs.length - 1);
        const cur = grp.imgs[i];
        const pal = palOf(grp.cidx);
        if (!portalRoot) return null;
        return createPortal(
          <div className="nc-lb" onPointerDown={() => setLbOpen(false)}>
            <div className="nc-lb-rail" onPointerDown={(e) => e.stopPropagation()}>
              {lbGroups.map((gr, gi) => { const gp = palOf(gr.cidx); return (
                <button key={gr.sig} className={"nc-lb-railitem" + (gi === g ? " on" : "")} style={{ borderColor: gi === g ? gp.bar : "transparent" }}
                  title={"Group " + (gi + 1) + " · " + gr.imgs.length + " image" + (gr.imgs.length === 1 ? "" : "s")}
                  onClick={() => { setLbG(gi); setLbI(0); }}>
                  <img src={gr.imgs[0].img || undefined} alt="" draggable={false} />
                  <span className="nc-lb-raildot" style={{ background: gp.bar }} />
                </button>
              ); })}
            </div>
            <div className="nc-lb-stage" onPointerDown={(e) => e.stopPropagation()}>
              <div className="nc-lb-mainwrap">
                <img className="nc-lb-main" src={cur.img || undefined} alt="output" draggable={false} />
              </div>
              {grp.imgs.length > 1 && (
                <div className="nc-lb-strip">
                  {grp.imgs.map((im, ii) => (
                    <button key={im.id} className={"nc-lb-thumb" + (ii === i ? " on" : "")} style={{ borderColor: ii === i ? pal.bar : "transparent" }} onClick={() => setLbI(ii)}>
                      <img src={im.img || undefined} alt="" draggable={false} />
                    </button>
                  ))}
                </div>
              )}
              <div className="nc-lb-meta">
                <span className="nc-lb-badge" style={{ background: pal.bg, color: pal.ink }}>Group {g + 1}/{lbGroups.length}</span>
                <span className="nc-lb-count">Image {i + 1}/{grp.imgs.length}</span>
                <span className="nc-lb-hint">↑ ↓ groups · ← → images · Esc close</span>
              </div>
            </div>
            <button className="nc-lb-close" onPointerDown={(e) => e.stopPropagation()} onClick={() => setLbOpen(false)} title="Close (Esc)"><Icon name="x" size={20} stroke={2} /></button>
          </div>, portalRoot);
      })()}

      {/* maximized reference image — portaled over the whole screen (incl. sidebar) */}
      {refMax && portalRoot && createPortal(
        <div className="nc-refmax" onPointerDown={() => setRefMax(null)}>
          <img className="nc-refmax-img" src={refMax} alt="reference" draggable={false} onPointerDown={(e) => e.stopPropagation()} />
          <button className="nc-refmax-x" onPointerDown={(e) => e.stopPropagation()} onClick={() => setRefMax(null)} title="Close (Esc)"><Icon name="x" size={20} stroke={2} /></button>
        </div>, portalRoot)}

      {/* co-generate dialog: leftover empty slots set up with different settings */}
      {genConfirm && portalRoot && createPortal((() => {
        const items = genConfirm.ids.map((id) => {
          const o = st.nodes.find((n) => n.id === id);
          const con = (st.cons || []).find((c) => c.sig === o?.sig);
          const fp = o ? buildPrompt(con?.body || st.body, texts, o.vals || {}, st.nodes) : "";
          const vars = Object.entries((o?.vals) || {}).filter(([, v]) => v);
          return { id, fp, vars };
        });
        const allOn = genConfirm.checked.size === items.length && items.length > 0;
        const total = genConfirm.checked.size * perImage;
        const toggle = (id: string) => setGenConfirm((g) => { if (!g) return g; const n = new Set(g.checked); if (n.has(id)) n.delete(id); else n.add(id); return { ...g, checked: n }; });
        return (
          <div className="nc-gconf-scrim" onPointerDown={() => setGenConfirm(null)}>
            <div className="nc-gconf" onPointerDown={(e) => e.stopPropagation()}>
              <div className="nc-gconf-h">You set up {items.length} empty image{items.length > 1 ? "s" : ""} with different settings and haven&apos;t generated {items.length > 1 ? "them" : "it"} yet. Pick which to generate too — nothing is removed.</div>
              <button className="nc-gconf-all" onClick={() => setGenConfirm((g) => g ? { ...g, checked: allOn ? new Set() : new Set(items.map((i) => i.id)) } : g)}>
                <span className={"nc-gconf-cb" + (allOn ? " on" : "")}>{allOn && <Icon name="check" size={11} stroke={3} />}</span> Select all
              </button>
              <div className="nc-gconf-list">
                {items.map((it) => { const on = genConfirm.checked.has(it.id); return (
                  <button key={it.id} className={"nc-gconf-item" + (on ? " on" : "")} onClick={() => toggle(it.id)}>
                    <span className={"nc-gconf-cb" + (on ? " on" : "")}>{on && <Icon name="check" size={11} stroke={3} />}</span>
                    <span className="nc-gconf-body">
                      <span className="nc-gconf-prompt">{it.fp || "(no prompt text)"}</span>
                      {it.vars.length > 0 && <span className="nc-gconf-vars">{it.vars.map(([k, v]) => <span key={k} className="nc-gconf-var">{k.slice(1, -1)}: {String(v)}</span>)}</span>}
                    </span>
                  </button>
                ); })}
              </div>
              <div className="nc-gconf-foot">
                <span className="nc-gconf-total">Total to pay: <b>${total.toFixed(2)}</b></span>
                <div className="nc-gconf-btns">
                  <button className="nc-gconf-cancel" onClick={() => setGenConfirm(null)}>Not now</button>
                  <button className="nc-gconf-go" disabled={!genConfirm.checked.size} onClick={confirmCoGen}><Icon name="zap" size={13} stroke={2} fill="var(--cta-ink)" /> Generate {genConfirm.checked.size}</button>
                </div>
              </div>
            </div>
          </div>
        );
      })(), portalRoot)}

      {/* In-place variable editor — anchored beside the clicked chip (left when
          space allows, right otherwise; clamped to the viewport → responsive).
          SAME UI as the input node card on the canvas: rename, Text/Checkbox
          toggle, value, "Checked by default", "Publicly visible". Both edit the
          same node state, so the card on the left mirrors every change live. */}
      {tokEdit && portalRoot && createPortal((() => {
        const t = st.nodes.find((n) => n.type === "text" && n.name === tokEdit.name);
        if (!t) return null;
        const c = colorForTok("[" + tokEdit.name + "]");
        const W = 260;
        const vw = window.innerWidth, vh = window.innerHeight;
        const left = tokEdit.rect.left - W - 10 >= 8
          ? tokEdit.rect.left - W - 10
          : Math.max(8, Math.min(tokEdit.rect.right + 10, vw - W - 8));
        const top = Math.max(8, Math.min(tokEdit.rect.top - 10, vh - 230));
        return (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 1394 }} onPointerDown={() => setTokEdit(null)} />
            <div
              style={{
                position: "fixed", left, top, width: W, zIndex: 1395,
                background: "var(--enki-paper-2)", border: "1px solid " + c.border,
                borderRadius: 12, boxShadow: "0 14px 36px rgba(0,0,0,0.28)", padding: "10px 12px",
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setTokEdit(null); }}
            >
              {/* head — same as the node card: colored dot + renameable name */}
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: c.bg, boxShadow: "inset 0 0 0 1px " + c.border, flexShrink: 0 }} />
                <EditName
                  className="nc-ntitle"
                  value={t.name || ""}
                  onChange={(v) => {
                    const clean = v.replace(/[[\]\n]/g, "");
                    if (!clean) return;
                    renameText(t.id, clean);
                    setTokEdit((prev) => (prev ? { ...prev, name: clean } : prev));
                  }}
                  placeholder={t.name}
                  title={`Double-click to change the name of "${t.name}"`}
                />
              </div>
              {/* body — identical controls to the canvas card */}
              <div className="nc-vtoggle">
                <button className={t.kind === "text" ? "active" : ""} title="Text — the user types their own words" onClick={() => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === t.id ? { ...n, kind: "text", value: n.value === "on" || n.value === "off" || n.value === "Yes" ? (n.str || "") : n.value } : n)) }))}>Text</button>
                <button className={t.kind === "bool" ? "active" : ""} title="Checkbox — the user just toggles this detail on or off (no typing)" onClick={() => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === t.id ? { ...n, kind: "bool", str: n.str && n.str.trim() ? n.str : n.value, value: n.value === "off" ? "off" : "on", pub: false } : n)) }))}>Checkbox</button>
              </div>
              {t.kind === "text" ? (
                <textarea autoFocus className="nc-vin nc-varea" placeholder={"Default value · e.g. " + t.name} value={t.value} onChange={(e) => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === t.id ? { ...n, value: e.target.value } : n)) }))} onPointerDown={(e) => e.stopPropagation()} spellCheck={false} />
              ) : (
                <>
                  <textarea autoFocus className="nc-vin nc-varea" placeholder={"Prompt added when checked · e.g. " + t.name} value={t.str || ""} onChange={(e) => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === t.id ? { ...n, str: e.target.value } : n)) }))} onPointerDown={(e) => e.stopPropagation()} spellCheck={false} />
                  <label className="nc-chk" title="Default state of the checkbox the user will see" onClick={() => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === t.id ? { ...n, value: n.value === "on" || n.value === "Yes" ? "off" : "on" } : n)) }))}>
                    <span className={"nc-chk-box" + (t.value === "on" || t.value === "Yes" ? " on" : "")}>{(t.value === "on" || t.value === "Yes") && <Icon name="check" size={11} stroke={3} />}</span> Checked by default
                  </label>
                </>
              )}
              {/* Only TEXT variables can be public — checkbox vars are helper vars. */}
              {t.kind === "text" && <label className="nc-chk" onClick={() => setSt((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === t.id ? { ...n, pub: !n.pub } : n)) }))}>
                <span className={"nc-chk-box" + (t.pub ? " on" : "")}>{t.pub && <Icon name="check" size={11} stroke={3} />}</span> Publicly visible (user input)
              </label>}
            </div>
          </>
        );
      })(), portalRoot)}

      {closeConfirm && portalRoot && createPortal(
        <div className="ek-modal-scrim" onClick={() => setCloseConfirm(false)} style={{ zIndex: 1400 }}>
          <div className="ek-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="ek-modal-head">
              <span className="ek-sheet-bolt"><Icon name="sparkles" size={17} stroke={2} /></span>
              <span className="ek-modal-title">Keep your work?</span>
              <button className="ek-modal-x" onClick={() => setCloseConfirm(false)}><Icon name="x" size={17} stroke={2} /></button>
            </div>
            <div className="ek-modal-body">
              <p style={{ fontSize: 13.5, color: "var(--enki-ink-3)", lineHeight: 1.55, marginBottom: 18 }}>
                You have unsaved changes in this prompt. Save them as a draft in your browser —
                it&apos;ll be right here next time — or throw them away.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button className="ek-btn" style={{ minHeight: 44 }} onClick={saveDraftAndClose}>
                  <Icon name="check" size={15} stroke={2} /> Save draft & leave
                </button>
                <button
                  onClick={discardAndClose}
                  style={{ minHeight: 44, borderRadius: 10, border: "1px solid var(--enki-rule)", background: "transparent", color: "#e0392b", fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}
                >
                  Discard changes
                </button>
                <button
                  onClick={() => setCloseConfirm(false)}
                  style={{ minHeight: 36, border: "none", background: "transparent", color: "var(--enki-ink-3)", fontSize: 12.5, cursor: "pointer" }}
                >
                  Keep editing
                </button>
              </div>
            </div>
          </div>
        </div>,
        portalRoot
      )}
    </div>
  );
}
