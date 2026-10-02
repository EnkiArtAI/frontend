"use client";

/* Doc view for Create Prompt 2 — the "Enki Docs Editor" design: edit the
   prompt like a document (serif page, token chips, comment-rail variable
   cards with dashed connector lines, refs + generate at the page foot,
   results/release on the right).
   It is a THIN SKIN over NodeCreator's `st`: every mutation goes through the
   same handlers the node canvas uses, so both views stay in perfect sync. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { Gem } from "lucide-react";
import { useModelCatalogue, resolveCatalogueEntry } from "@/hooks/useModelLimits";
import RatioRect from "@/components/generation/RatioRect";
import { variableRange } from "@/lib/editor/selection-variable";
import { DiceButton } from "@/components/DiceButton";
import { DICE_LIMITS, type DiceValue, type DiceVariable } from "@/lib/generation/variable-dice";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { railVars as railVarsOf } from "@/lib/editor/rail-vars";
import {
  EditName, NcSelect, ncQualities, ncRatios, TOKEN_RE, isRefTok,
  type Con, type EditorView, type Kind, type NodeT, type St, type TextNode,
} from "./NodeCreator";

export interface DocViewApi {
  st: St;
  texts: TextNode[];
  refs: NodeT[];
  outs: NodeT[];
  cons: Con[];
  curSig: string;
  liveTokNames: Set<string>;
  liveRefCount: number;
  pubNames: Set<string>;
  colorForTok: (tok: string) => { bg: string; text: string; border: string; dot: string };
  palOf: (cidx: number) => { bg: string; bar: string; ink: string; soft: string };
  /** Server quote for one image at the current settings, "Free", or "…". */
  priceLabel: string;
  modelPriceLabel: (id: string) => string | undefined;
  tierPriceLabel: (tier: string) => string | undefined;
  /** The tier that runs: the pick clamped to the selected model's ceiling. */
  effTier: string;
  canGenerate: boolean;
  pickedOuts: NodeT[];
  releaseMin: number;
  canRelease: boolean;
  modelAccept: string;
  onBodyChange: (v: string) => void;
  pushHist: () => void;
  addText: (atPos?: { x: number; y: number }, presetName?: string) => void;
  patchText: (id: string, patch: Partial<NodeT>) => void;
  setTextKind: (id: string, kind: Kind) => void;
  renameText: (id: string, name: string) => void;
  deleteNodeId: (id: string) => void;
  addRefsFromFiles: (files: FileList | null) => void;
  onRefFiles: (id: string, files: FileList | null) => void;
  toggleRefUserInput: (id: string) => void;
  setRefMax: (url: string | null) => void;
  spawnOutput: (autofill?: boolean) => void;
  togglePick: (id: string) => void;
  release: () => void;
  openLightbox: (id: string) => void;
  setModel: (id: string) => void;
  setRatio: (v: string) => void;
  setQuality: (v: string) => void;
  /* The gpt low/medium/high lever — model-specific settings live where the
     prompt is written, in BOTH views. */
  gptQuality: string;
  setGptQuality: (v: string) => void;
  supportsGptQuality: boolean;
  onToast: (msg: string) => void;
  switchView: (v: EditorView) => void;
}

// Adjustable column widths (page ↔ variables ↔ results), persisted.
const COLS_KEY = "enki-doc-cols";
const PAGE_W = { lo: 380, hi: 860, dflt: 612 };
/* Results can go down to 180: everything inside degrades gracefully (the
   tile strip scrolls, the release row wraps), and the low floor is what lets
   the variables rail reach ITS 190px minimum on narrow viewports — at 260
   the rail was the column that had to give (Kev, 2026-08-22). */
const RESULTS_W = { lo: 180, hi: 560, dflt: 380 };
const clampW = (v: unknown, b: { lo: number; hi: number; dflt: number }) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(b.hi, Math.max(b.lo, v)) : b.dflt;
const loadCols = () => {
  try {
    const j = JSON.parse(localStorage.getItem(COLS_KEY) || "") as { page?: number; results?: number };
    return { page: clampW(j.page, PAGE_W), results: clampW(j.results, RESULTS_W) };
  } catch {
    return { page: PAGE_W.dflt, results: RESULTS_W.dflt };
  }
};

const CARD_GAP = 7;
const FALLBACK_CARD_H = 60;

export default function DocView({ api }: { api: DocViewApi }) {
  const {
    st, texts, refs, outs, cons, curSig, liveTokNames, liveRefCount, pubNames,
    colorForTok, palOf, priceLabel, canGenerate, pickedOuts, releaseMin, canRelease,
  } = api;
  // Same catalogue the node view uses, from /api/models — never a constant,
  // so the two views cannot drift into offering different models or prices.
  const catalogue = useModelCatalogue();

  // Which variable card is open in the rail (token incl. brackets), and the
  // floating "+ Add variable" pill (page-relative position + selection range).
  const [openVar, setOpenVar] = useState<string | null>(null);
  // How the card was opened: only a CHIP click makes the card fly to the
  // chip's height — toggling via the card header expands it in place.
  const [openVia, setOpenVia] = useState<"chip" | "head">("head");
  const [pill, setPill] = useState<{ x: number; y: number; start: number; end: number } | null>(null);
  const [autoFill, setAutoFill] = useState(true);
  const [cols, setCols] = useState(loadCols);
  const [levering, setLevering] = useState<"page" | "results" | null>(null);
  // Card layout engine: measured tops (null = its token is scrolled out of
  // view), connector lines, manual order override, and the drag in flight.
  const [tops, setTops] = useState<Record<string, number | null>>({});
  const [lines, setLines] = useState<Array<{ tok: string; d: string; x1: number; x2: number; color: string; active: boolean }>>([]);
  const [railH, setRailH] = useState(280);
  const [varOrder, setVarOrder] = useState<string[] | null>(null);
  const [dragTok, setDragTok] = useState<string | null>(null);
  const [dragY, setDragY] = useState(0);
  const [confirmDel, setConfirmDel] = useState<TextNode | null>(null);

  const openVarRef = useRef(openVar); openVarRef.current = openVar;
  const openViaRef = useRef(openVia); openViaRef.current = openVia;
  const confirmDelRef = useRef(confirmDel); confirmDelRef.current = confirmDel;
  const pillRef = useRef(pill); pillRef.current = pill;
  const colsRef = useRef(cols); colsRef.current = cols;
  const topsRef = useRef(tops); topsRef.current = tops;
  const varOrderRef = useRef(varOrder); varOrderRef.current = varOrder;
  const pageRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const refUpRef = useRef<HTMLInputElement | null>(null);
  const measureRaf = useRef<number | null>(null);
  const lastMeasureRef = useRef("");
  const suppressClickRef = useRef(false);
  const dragTokRef = useRef<string | null>(null); dragTokRef.current = dragTok;
  // Queued WAAPI card moves: moved cards glide from→to; brand-new cards have
  // no `from` and simply appear at their slot (no fly-in from 0).
  const pendingAnimRef = useRef(new Map<string, { from: number; to: number }>());
  const dropFromRef = useRef<{ tok: string; y: number } | null>(null);
  const playPend = () => {
    const pend = pendingAnimRef.current;
    if (!pend.size || !railRef.current) return;
    railRef.current.querySelectorAll<HTMLElement>("[data-vcard]").forEach((el) => {
      const a = pend.get(el.dataset.vcard as string);
      if (a) el.animate([{ top: a.from + "px" }, { top: a.to + "px" }], { duration: 180, easing: "ease" });
    });
    pend.clear();
  };

  // ESC closes doc-local popups BEFORE NodeCreator's close flow sees the key.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmDelRef.current) {
        e.stopPropagation();
        setConfirmDel(null);
        return;
      }
      if (openVarRef.current || pillRef.current) {
        e.stopPropagation();
        setOpenVar(null);
        setPill(null);
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);

  /* ── remove a variable (confirmed): its default value — or, without one,
     its bare name — takes the token's place in the prompt text. The chip,
     card and connector line all go with the same body change. ── */
  const confirmRemoveVar = () => {
    const t = confirmDel;
    if (!t) return;
    const tok = "[" + t.name + "]";
    // What the token EFFECTIVELY contributes: text vars → their value; checkbox
    // vars → the snippet only when checked, nothing when unchecked (inserting
    // str for an off checkbox would silently change every future render).
    const checked = t.value === "on" || t.value === "Yes";
    const raw = t.kind === "bool" ? (checked ? (t.str ?? "") : "") : (t.value ?? "");
    const fallback = t.kind === "bool" ? "" : t.name; // no default → keep the name (text vars only)
    // brackets in a default would spawn NEW tokens — strip them
    const repl = (raw.trim() || fallback).replace(/[[\]]/g, "");
    api.pushHist();
    // onBodyChange's orphan cleanup drops the text node in the same update
    api.onBodyChange(st.body.split(tok).join(repl).replace(/ {2,}/g, " "));
    if (openVar === tok) setOpenVar(null);
    setConfirmDel(null);
    api.onToast(
      raw.trim() ? "Variable removed — its default value stayed in the text."
      : repl ? "Variable removed — its name stayed in the text."
      : "Variable removed.",
    );
  };

  // The pill lives EXACTLY as long as a real selection does: whenever the
  // textarea's selection collapses (click, arrow key, blur), it goes away.
  useEffect(() => {
    const onSel = () => {
      if (!pillRef.current) return;
      const ta = taRef.current;
      if (!ta || document.activeElement !== ta || ta.selectionStart === ta.selectionEnd) setPill(null);
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  // Column levers: drag to shift width between page↔variables↔results.
  const startLever = (which: "page" | "results") => (e: React.PointerEvent) => {
    e.preventDefault();
    const sx = e.clientX;
    const w0 = which === "page" ? colsRef.current.page : colsRef.current.results;
    setLevering(which);
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      setCols((c) =>
        which === "page"
          ? { ...c, page: clampW(w0 + dx, PAGE_W) }
          : { ...c, results: clampW(w0 - dx, RESULTS_W) },
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = prevSelect;
      setLevering(null);
      try { localStorage.setItem(COLS_KEY, JSON.stringify(colsRef.current)); } catch { /* noop */ }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /* ── selection → variable ──
     The pill is shown DEFERRED and re-verified: on a click into an existing
     selection the browser only collapses it AFTER mouseup, so a synchronous
     read still sees the old range and flashes a phantom pill. 80ms later the
     selection state is final — only a selection that survives gets the pill. */
  const pillTimer = useRef<number | null>(null);
  useEffect(() => () => { if (pillTimer.current) window.clearTimeout(pillTimer.current); }, []);
  const schedulePill = (e: { clientX?: number; clientY?: number }) => {
    const cx = e.clientX, cy = e.clientY;
    if (pillTimer.current) window.clearTimeout(pillTimer.current);
    pillTimer.current = window.setTimeout(() => {
      pillTimer.current = null;
      const ta = taRef.current, page = pageRef.current;
      if (!ta || !page || document.activeElement !== ta) { setPill(null); return; }
      const s = ta.selectionStart, en = ta.selectionEnd;
      // Shared validation (lib/editor/selection-variable): whitespace-only,
      // bracket-touching and token-overlapping selections never get a pill.
      if (!variableRange(ta.value, s, en)) { setPill(null); return; }
      const r = page.getBoundingClientRect();
      // The design anchors the pill to the mouse — cheap and always visible.
      const x = Math.max(8, Math.min((cx ?? r.left + 80) - r.left - 56, r.width - 150));
      const y = (cy ?? r.top + 40) - r.top + 18;
      setPill({ x, y, start: s, end: en });
    }, 80);
  };
  const addVariableFromPill = () => {
    if (!pill) return;
    // Same shared validation as the pill itself — the splice can only do
    // what the pill promised, even if the body changed underneath.
    const r = variableRange(st.body, pill.start, pill.end);
    if (!r) { setPill(null); return; }
    const { start: s2, end: e2, name: seg } = r;
    const body = st.body.slice(0, s2) + "[" + seg + "]" + st.body.slice(e2);
    // Body first, then the backing node: addText sees the token already in the
    // (queued) body and skips its own append — same path as typing a token.
    api.onBodyChange(body);
    if (!texts.some((t) => t.name === seg)) api.addText(undefined, seg);
    setPill(null);
    setOpenVia("chip"); // align the fresh card with its new chip
    setOpenVar("[" + seg + "]");
    api.onToast(`"${seg}" is now a variable.`);
  };

  /* ── rail cards: body order, overridden by the user's manual order ──
     The rule lives in lib/editor/rail-vars.ts so it can be tested without a
     DOM; it is the list every card, top and connector line keys on. */
  const orderedVars = useMemo(() => railVarsOf(st.body, texts, varOrder), [st.body, texts, varOrder]);
  /* Same derivation as the node view: the tiers the selected model genuinely
     renders, from /api/models, not a hardcoded list. */
  const docCatalogue = useModelCatalogue();
  /* Resolver, not an exact-id find: drafts carry the model as a slug. */
  const docModel = resolveCatalogueEntry(docCatalogue, st.models[0]);
  const docTiers = ncQualities(st.mode, docModel?.maxResolution);
  const orderedVarsRef = useRef(orderedVars); orderedVarsRef.current = orderedVars;

  const needsSetup = (t: TextNode) => (t.kind === "bool" ? !(t.str && t.str.trim()) : !t.value.trim());

  /* ── the layout engine: anchor cards to their token chips, pack gap-free ──
     Each visible token's card wants to sit at the chip's height; cards are
     placed in order at max(anchor, cursor) so nothing overlaps and no holes
     open up. The OPEN card claims exactly its chip's height; cards before it
     pack upward, cards after it pack downward. Off-screen tokens' cards fade
     out and free their space. Connector curves are computed from the same
     measurements. */
  const measure = useCallback(() => {
    const wrap = wrapRef.current, rail = railRef.current, scroller = scrollerRef.current, page = pageRef.current;
    if (!wrap || !rail || !scroller || !page) return;
    const wrapR = wrap.getBoundingClientRect();
    const railR = rail.getBoundingClientRect();
    const scR = scroller.getBoundingClientRect();

    const anchors = new Map<string, { y: number; cy: number; x: number }>();
    page.querySelectorAll<HTMLElement>("[data-tok]").forEach((el) => {
      const tok = el.dataset.tok as string;
      if (anchors.has(tok)) return; // first occurrence anchors the card
      const r = el.getBoundingClientRect();
      if (r.bottom < scR.top + 4 || r.top > scR.bottom - 4) return; // scrolled away
      anchors.set(tok, { y: r.top - railR.top, cy: r.top + r.height / 2 - wrapR.top, x: r.right - wrapR.left });
    });
    const heights = new Map<string, number>();
    rail.querySelectorAll<HTMLElement>("[data-vcard]").forEach((el) => {
      heights.set(el.dataset.vcard as string, el.offsetHeight);
    });

    const toks = orderedVarsRef.current.map((t) => "[" + t.name + "]");
    const vis = toks.filter((tk) => anchors.has(tk));
    const nextTops: Record<string, number | null> = {};
    toks.forEach((tk) => { if (!anchors.has(tk)) nextTops[tk] = null; });

    const hOf = (tk: string) => heights.get(tk) ?? FALLBACK_CARD_H;
    const flowDown = (list: string[], cursor: number) => {
      for (const tk of list) {
        const top = Math.max(anchors.get(tk)!.y - 4, cursor);
        nextTops[tk] = top;
        cursor = top + hOf(tk) + CARD_GAP;
      }
    };
    // Only a chip-click anchors the open card to its chip; a header toggle
    // keeps the normal top-down flow so nothing jumps around.
    const open = openVarRef.current;
    const openIdx = open && openViaRef.current === "chip" ? vis.indexOf(open) : -1;
    if (openIdx >= 0) {
      const need = (arr: string[]) => arr.reduce((s, tk) => s + hOf(tk) + CARD_GAP, 0);
      const before = vis.slice(0, openIdx);
      // If the cards above don't fit over the anchor, the open card yields
      // downward — overlap is never allowed.
      const openTop = Math.max(anchors.get(vis[openIdx])!.y - 4, need(before));
      let cursor = 0;
      before.forEach((tk, i) => {
        const cap = openTop - need(before.slice(i)); // room the rest still needs
        const top = Math.max(0, Math.min(Math.max(anchors.get(tk)!.y - 4, cursor), cap));
        nextTops[tk] = top;
        cursor = top + hOf(tk) + CARD_GAP;
      });
      nextTops[vis[openIdx]] = openTop;
      flowDown(vis.slice(openIdx + 1), openTop + hOf(vis[openIdx]) + CARD_GAP);
    } else {
      flowDown(vis, 0);
    }

    let maxB = 240;
    vis.forEach((tk) => { const t = nextTops[tk]; if (typeof t === "number") maxB = Math.max(maxB, t + hOf(tk)); });

    // queue glide animations for cards that MOVED (never for fresh mounts)
    const prevT = topsRef.current;
    vis.forEach((tk) => {
      const next = nextTops[tk];
      if (typeof next !== "number" || dragTokRef.current === tk) return;
      let from: number | null = null;
      if (dropFromRef.current?.tok === tk) { from = dropFromRef.current.y; dropFromRef.current = null; }
      else if (typeof prevT[tk] === "number") from = prevT[tk] as number;
      if (from !== null && Math.abs(from - next) > 1) pendingAnimRef.current.set(tk, { from, to: next });
    });

    const railX = railR.left - wrapR.left;
    const railY = railR.top - wrapR.top;
    const nextLines = vis
      .filter((tk) => typeof nextTops[tk] === "number")
      .map((tk) => {
        const a = anchors.get(tk)!;
        const x1 = a.x + 2, y1 = a.cy;
        const x2 = railX - 2, y2 = railY + (nextTops[tk] as number) + 15;
        const mx = (x1 + x2) / 2;
        /* x1/x2 ride along for the stroke gradient: the segment over the
           page text is muted, full strength arrives at the rail. */
        return { tok: tk, d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, x1, x2, color: colorForTok(tk).border, active: openVarRef.current === tk };
      });

    const sig = JSON.stringify([nextTops, nextLines.map((l) => l.d + l.active), maxB]);
    if (sig === lastMeasureRef.current) {
      // DOM already sits at these tops (e.g. a drop back into the same slot) —
      // play any queued glide right away.
      playPend();
      return;
    }
    lastMeasureRef.current = sig;
    setTops(nextTops);
    setLines(nextLines);
    setRailH(maxB + 8);
  }, [colorForTok]);
  const scheduleMeasure = useCallback(() => {
    if (measureRaf.current) cancelAnimationFrame(measureRaf.current);
    measureRaf.current = requestAnimationFrame(() => { measureRaf.current = null; measure(); });
  }, [measure]);
  // After every commit: play queued card glides (DOM now holds the new tops),
  // then re-measure SYNCHRONOUSLY — deferring to rAF would let the browser
  // paint a fresh card once at top 0, overlapping its neighbors for a frame.
  useLayoutEffect(() => { playPend(); measure(); });
  useEffect(() => {
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      if (measureRaf.current) cancelAnimationFrame(measureRaf.current);
    };
  }, [scheduleMeasure]);

  /* ── drag a card by its header to reorder; the rest repack live ── */
  const startCardDrag = (tok: string) => (e: React.PointerEvent) => {
    // name (double-click rename), trash and fields keep their own gestures —
    // note the head itself IS a button, so don't match on "button" here
    if ((e.target as HTMLElement).closest("[data-noreorder],.ncd-vtrash,input,textarea")) return;
    e.preventDefault();
    const rail = railRef.current; if (!rail) return;
    const startTop = topsRef.current[tok] ?? 0;
    const offY = e.clientY - (rail.getBoundingClientRect().top + startTop);
    let moved = false;
    setDragTok(tok);
    setDragY(startTop);
    const onMove = (ev: PointerEvent) => {
      const r = rail.getBoundingClientRect();
      const y = ev.clientY - r.top - offY;
      if (!moved && Math.abs(y - startTop) > 5) moved = true;
      setDragY(y);
      if (!moved) return;
      // live reorder: sort every card by its current visual center
      const centers = orderedVarsRef.current.map((t) => {
        const tk = "[" + t.name + "]";
        const top = tk === tok ? y : topsRef.current[tk];
        return { name: t.name, c: typeof top === "number" ? top + 20 : Number.MAX_SAFE_INTEGER };
      });
      const next = centers.sort((a, b) => a.c - b.c).map((x) => x.name);
      const cur = orderedVarsRef.current.map((t) => t.name);
      if (next.join("|") !== cur.join("|")) setVarOrder(next);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // let the dropped card glide from where it was released into its slot
      const r = rail.getBoundingClientRect();
      dropFromRef.current = { tok, y: ev.clientY - r.top - offY };
      setDragTok(null);
      if (moved) {
        suppressClickRef.current = true; // a real drag must not toggle the card
        // a drop outside the header never fires the click — don't let the flag
        // swallow the NEXT genuine click
        window.setTimeout(() => { suppressClickRef.current = false; }, 250);
      }
      scheduleMeasure();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /* ── results groups: constellation rows with their outputs ── */
  const groups = useMemo(
    () =>
      cons
        .map((c) => ({ con: c, pal: palOf(c.cidx), outs: outs.filter((o) => o.sig === c.sig), current: c.sig === curSig }))
        .filter((g) => g.outs.length > 0),
    [cons, outs, curSig, palOf],
  );


  /* ── 🎲 the dice beside Generate: rail vars → DiceVariable, keyed by the
     node id patchText applies values back under. A checkbox's snippet rides
     along as description so the model knows what "on" would add. ── */
  const diceVars = useMemo<DiceVariable[]>(
    () =>
      texts.map((t): DiceVariable =>
        t.kind === "bool"
          ? { id: t.id, name: t.name, type: "checkbox",
              description: t.str?.trim() ? "When on, adds to the prompt: " + t.str.trim() : undefined }
          : { id: t.id, name: t.name, type: "text" },
      ),
    [texts],
  );
  const applyDiceValues = (values: Record<string, DiceValue>) => {
    api.pushHist(); // one roll = one undo step
    for (const [id, v] of Object.entries(values)) {
      const t = texts.find((x) => x.id === id);
      if (!t) continue;
      if (t.kind === "bool") {
        if (typeof v === "boolean") api.patchText(id, { value: v ? "on" : "off" });
      } else if (typeof v === "string") {
        // brackets in a value would be re-substituted as tokens by buildPrompt —
        // strip them, same defense as confirmRemoveVar
        api.patchText(id, { value: v.replace(/[[\]]/g, "") });
      }
    }
  };
  // Confirm dialog portals above the whole shell, same as NodeCreator's modals.
  const portalRoot = typeof document !== "undefined" ? ((document.querySelector(".ek-app") as HTMLElement) || document.body) : null;

  return (
    <div className="ncd" onPointerDown={(e) => {
      // Clicking plain desk (not a card, chip, the pill or a portaled modal —
      // portals bubble through the REACT tree) closes the open card.
      const t = e.target as HTMLElement;
      if (!t.closest("[data-vcard]") && !t.closest(".nc-tok") && !t.closest(".ncd-pill") && !t.closest(".ek-modal-scrim")) setOpenVar(null);
    }}>
      <div className="ncd-desk">
        <div className="ncd-wrap" ref={wrapRef}>
          {/* ── the page ── */}
          <div className="ncd-page" ref={pageRef} style={{ width: cols.page, flex: "0 0 auto" }}>
            <div className="ncd-tascroll" ref={scrollerRef} onScroll={() => { setPill(null); scheduleMeasure(); }}>
            <div className="ncd-pbox">
              <div className="ncd-pov" aria-hidden>
                {(() => {
                  const parts = st.body.split(TOKEN_RE);
                  return parts.map((part, i) => {
                    if (!/^\[[^\]\n]+\]$/.test(part)) return <span key={i}>{part}</span>;
                    const name = part.slice(1, -1);
                    const refTok = isRefTok(part);
                    const refN = refTok ? parseInt(part.replace(/\D/g, ""), 10) : 0;
                    const alive = refTok ? refN >= 1 && refN <= liveRefCount : liveTokNames.has(name);
                    if (!alive) return <span key={i}>{part}</span>;
                    const c = colorForTok(part);
                    // Same rule as NodeCreator: a reference image marked as
                    // user input gets the ring on its token too, not just on
                    // its card. Ref tokens are numbered by position.
                    const isPub = refTok ? !!refs[refN - 1]?.userInput : pubNames.has(name);
                    return (
                      <span key={i}
                        data-tok={refTok ? undefined : part}
                        className={"nc-tok" + (isPub ? " pub" : "") + (openVar === part ? " ncd-tok-open" : "")}
                        style={{
                          "--tok-bg": c.bg,
                          "--tok-ring": isPub ? "inset 0 0 0 1px " + c.border + ", 0 0 0 2px var(--enki-turq)" : "inset 0 0 0 1px " + c.border,
                          color: c.text,
                        } as React.CSSProperties}
                        title={refTok ? "Reference image " + refN : "Click to edit this variable"}
                        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); if (!refTok) { setOpenVia("chip"); setOpenVar((v) => (v === part ? null : part)); } }}
                      >
                        <span className="nc-tok-br">[</span>{name}<span className="nc-tok-br">]</span>
                      </span>
                    );
                  });
                })()}{"\n"}
              </div>
              <textarea
                ref={taRef}
                className="ncd-pta"
                value={st.body}
                placeholder="Describe your image. Wrap any word in [brackets] — or select it and click Add variable — to turn it into a variable."
                spellCheck={false}
                onChange={(e) => { api.onBodyChange(e.target.value); setPill(null); }}
                onFocus={api.pushHist}
                onMouseUp={schedulePill}
                onKeyUp={(e) => { if (e.shiftKey || e.key === "Shift") schedulePill({}); }}
                onBlur={() => setTimeout(() => setPill(null), 180)}
              />
            </div>
            </div>

            {pill && (
              <button className="ncd-pill" style={{ left: pill.x, top: pill.y }}
                onMouseDown={(e) => { e.preventDefault(); addVariableFromPill(); }}>
                <Icon name="plus" size={12} stroke={2.6} /> Add variable
              </button>
            )}

            {/* ── page foot: refs+settings left · Auto Fill+Generate right ── */}
            <div className="ncd-foot">
              <div className="ncd-foot-l">
              <div className="ncd-refs">
                <span className="ncd-lab">Refs</span>
                {refs.map((r, i) => (
                  <span key={r.id} className={"ncd-ref" + (r.userInput ? " ui" : "")}>
                    {r.img ? (
                      <img src={r.img} alt={"reference " + (i + 1)} draggable={false} title="Click to maximize" onClick={() => api.setRefMax(r.img!)} />
                    ) : (
                      <label className="ncd-ref-up" title="Upload this reference image">
                        <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => { api.onRefFiles(r.id, e.target.files); e.currentTarget.value = ""; }} />
                        <Icon name="image" size={12} stroke={1.8} />
                      </label>
                    )}
                    <button className="ncd-ref-x" title="Remove reference" onClick={() => api.deleteNodeId(r.id)}>×</button>
                    <button className={"ncd-ref-ui" + (r.userInput ? " on" : "")} role="checkbox" aria-checked={!!r.userInput}
                      title={r.userInput ? "User input — the buyer supplies this image" : "Mark as user input (buyer supplies this image)"}
                      onClick={() => api.toggleRefUserInput(r.id)}>
                      {r.userInput && <Icon name="check" size={7} stroke={4} />}
                    </button>
                  </span>
                ))}
                <button className="ncd-ref-add" title="Upload reference images" onClick={() => refUpRef.current?.click()}>+</button>
                <input ref={refUpRef} type="file" accept={api.modelAccept} multiple style={{ display: "none" }} onChange={(e) => { api.addRefsFromFiles(e.target.files); e.currentTarget.value = ""; }} />
              </div>
              {/* ONE row: model leads on the left, then ratio, resolution
                  and the gpt quality lever side by side. The stacked layout
                  read as fine print — a wide model box over two small selects
                  (Kev, 2026-08-19: "viel zu kleingedruckt ... model nach
                  links und any und resolution UND QUALITY nebeneinander"). */}
              <div className="ncd-genopts ncd-genopts--row">
                <NcSelect value={docModel?.id ?? "Pick a model"} width={150} title="Model used for this prompt"
                  options={catalogue.map((mm) => ({ value: mm.id, label: mm.name, sub: api.modelPriceLabel(mm.id) }))}
                  onChange={api.setModel} />
                <NcSelect icon={<span style={{ color: "var(--enki-ink-3)", display: "flex" }}><RatioRect ratio={st.ratio} size={13} /></span>} value={st.ratio} width={80} grow={false} title="Aspect ratio"
                  options={ncRatios(docModel).map((r) => ({ value: r, label: r, icon: <RatioRect ratio={r} size={15} /> }))} onChange={api.setRatio} />
                {docTiers.length > 0 && (
                  <NcSelect value={docTiers.includes(st.quality) ? st.quality : docTiers[docTiers.length - 1]} width={70} grow={false} title="Resolution"
                    options={docTiers.map((q) => ({ value: q, label: q, sub: api.tierPriceLabel(q) }))}
                    onChange={api.setQuality} />
                )}
                {api.supportsGptQuality && (
                  <NcSelect icon={<Gem size={13} style={{ color: "var(--enki-ink-3)" }} />} value={api.gptQuality} width={78} grow={false}
                    title="Quality — how much detail GPT-Image-2 renders. Higher quality costs more; the price shown is the server's quote."
                    options={[
                      { value: "low", label: "Low" },
                      { value: "medium", label: "Mid" },
                      { value: "high", label: "High" },
                    ]}
                    onChange={api.setGptQuality} />
                )}
              </div>
              </div>
              <div className="ncd-foot-r">
                <label className="nc-chk ncd-autofill" title="An AI writes the variable values for each new image before rendering" onClick={() => setAutoFill((v) => !v)}>
                  <span className={"nc-chk-box" + (autoFill ? " on" : "")}>{autoFill && <Icon name="check" size={11} stroke={3} />}</span> Auto&nbsp;Fill
                </label>
                {/* narrow page: the price wraps under the label to save width */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {/* renders null while the doc has no variables */}
                  <DiceButton
                    variables={diceVars}
                    /* the artist's OWN draft; sliced because the route's zod max
                       REJECTS an over-long context rather than clipping it */
                    context={st.body.trim() ? st.body.slice(0, DICE_LIMITS.maxContextLen) : undefined}
                    headers={sessionAuthHeaders()}
                    onValues={applyDiceValues}
                  />
                  <button className={"ncd-gen ncd-gen--go" + (cols.page < 540 ? " stack" : "") + (canGenerate ? "" : " disabled")}
                    title={canGenerate ? (autoFill ? "AI fills the variables, then renders · " + api.effTier : "Render with the current variable values · " + api.effTier) : "Write a prompt first"}
                    onClick={() => { if (!canGenerate) return; api.spawnOutput(autoFill); }}>
                    <span className="ncd-gen-top"><Icon name="zap" size={15} stroke={2.2} fill={canGenerate ? "var(--cta-ink)" : "none"} /> Generate</span>
                    <span className="ncd-gen-price">{priceLabel}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className={"ncd-lever" + (levering === "page" ? " on" : "")} title="Drag to resize the editor" onPointerDown={startLever("page")} />

          {/* dashed connectors from each chip to its card */}
          <svg className="ncd-lines" aria-hidden>
            {/* The stroke is a gradient in USER SPACE, not a colour: near the
                chip it runs at ~30% so the words it crosses stay readable
                (Kev, 2026-08-19), and it reaches full strength by the rail
                where there is nothing to read underneath. The chips
                themselves sit ABOVE this layer (z-index in nodes.css), so a
                line can never cross chip text at all. */}
            <defs>
              {lines.map((l, i) => (
                <linearGradient key={l.tok} id={"ncd-lg-" + i} gradientUnits="userSpaceOnUse" x1={l.x1} y1={0} x2={l.x2} y2={0}>
                  <stop offset="0%" stopColor={l.color} stopOpacity={0.28} />
                  <stop offset="55%" stopColor={l.color} stopOpacity={0.55} />
                  <stop offset="100%" stopColor={l.color} stopOpacity={1} />
                </linearGradient>
              ))}
            </defs>
            {lines.map((l, i) => (
              <path key={l.tok} className={l.active ? "active" : undefined} d={l.d} stroke={"url(#ncd-lg-" + i + ")"} />
            ))}
          </svg>

          {/* ── comment rail: variable cards, anchored to their chips ── */}
          <div className="ncd-rail" ref={railRef} style={{ height: railH }}>
            {/* insertion indicator while dragging a card: marks the slot it drops into */}
            {dragTok && typeof tops[dragTok] === "number" && (
              <div className="ncd-drop-line" style={{ top: (tops[dragTok] as number) - 5 }} />
            )}
            {orderedVars.length === 0 && (
              <div className="ncd-rail-empty">
                No variables yet. Select a word in your prompt and click <b>Add variable</b> — it will show up here like a comment.
              </div>
            )}
            {orderedVars.map((t) => {
              const tok = "[" + t.name + "]";
              const c = colorForTok(tok);
              const warn = needsSetup(t);
              // The header ALWAYS toggles — warn only colors the card red, it
              // never locks it open (Kev: collapse must always be possible).
              const open = openVar === tok;
              const top = tops[tok];
              const dragging = dragTok === tok;
              return (
                <div key={t.id} data-vcard={tok}
                  className={"ncd-vcard" + (open ? " open" : "") + (warn ? " warn" : "") + (top === null || top === undefined ? " hidden" : "") + (dragging ? " dragging" : "")}
                  style={{ borderLeftColor: c.border, top: dragging ? dragY : (top ?? 0) }}
                  onPointerDown={(e) => e.stopPropagation()}>
                  <button className="ncd-vhead" title="Drag to reorder"
                    onPointerDown={startCardDrag(tok)}
                    onClick={(e) => {
                      if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                      // the name is the rename affordance — clicks there never
                      // toggle (kills the double-click open/close flicker too)
                      if ((e.target as HTMLElement).closest("input,textarea,[data-noreorder]")) return;
                      setOpenVia("head");
                      setOpenVar((v) => (v === tok ? null : tok));
                    }}>
                    <span className="ncd-vdot" style={{ background: c.dot }} />
                    <span className="ncd-vname" style={{ color: c.text }} data-noreorder>
                      <EditName value={t.name} placeholder={t.name} title="Double-click to rename"
                        onChange={(v) => {
                          api.renameText(t.id, v);
                          // keep the open card open across the rename (openVar is
                          // keyed by token text) — only when the rename is valid
                          const clean = v.replace(/[[\]\n]/g, "");
                          if (clean.trim() && !texts.some((x) => x.id !== t.id && x.name === clean)) {
                            setOpenVar((cur) => (cur === tok ? "[" + clean + "]" : cur));
                          }
                        }} />
                    </span>
                    <span className={"ncd-vtype" + (t.kind === "bool" ? " bool" : "")}>{t.kind === "bool" ? "Checkbox" : "Text"}</span>
                    <span className="ncd-vtrash" role="button" title="Remove this variable"
                      onClick={(e) => { e.stopPropagation(); setConfirmDel(t); }}>
                      <Icon name="trash" size={12} stroke={2} />
                    </span>
                    <Icon name="chevronDown" size={12} stroke={2.4} style={{ transform: open ? "rotate(180deg)" : "none", opacity: warn ? 0.3 : 0.7, transition: "transform .15s" }} />
                  </button>
                  {!open ? (
                    <div className="ncd-vprev">{(t.kind === "bool" ? t.str : t.value)?.trim() || <i>No default yet — tap to add one.</i>}</div>
                  ) : (
                    <div className="ncd-vbody">
                      <div className="nc-vtoggle">
                        <button className={t.kind === "text" ? "active" : ""} title="The buyer types their own words" onClick={() => api.setTextKind(t.id, "text")}>Text</button>
                        <button className={t.kind === "bool" ? "active" : ""} title="The buyer just switches this on or off" onClick={() => api.setTextKind(t.id, "bool")}>Checkbox</button>
                      </div>
                      <span className="ncd-lab">Default value</span>
                      {t.kind === "text" ? (
                        <textarea className="nc-vin nc-varea" rows={3} spellCheck={false}
                          placeholder={"What the buyer starts with, e.g. " + t.name}
                          value={t.value}
                          onChange={(e) => api.patchText(t.id, { value: e.target.value })} />
                      ) : (
                        <>
                          <textarea className="nc-vin nc-varea" rows={3} spellCheck={false}
                            placeholder="Text added to the prompt when the buyer checks this"
                            value={t.str || ""}
                            onChange={(e) => api.patchText(t.id, { str: e.target.value })} />
                          <label className="nc-chk" onClick={() => api.patchText(t.id, { value: t.value === "on" || t.value === "Yes" ? "off" : "on" })}>
                            <span className={"nc-chk-box" + (t.value === "on" || t.value === "Yes" ? " on" : "")}>{(t.value === "on" || t.value === "Yes") && <Icon name="check" size={11} stroke={3} />}</span> Checked by default
                          </label>
                        </>
                      )}
                      {t.kind === "text" && (
                        <label className="nc-chk" onClick={() => api.patchText(t.id, { pub: !t.pub })}>
                          <span className={"nc-chk-box" + (t.pub ? " on" : "")}>{t.pub && <Icon name="check" size={11} stroke={3} />}</span> User input — buyer types their own words
                        </label>
                      )}
                      {warn && <div className="ncd-vwarn">No default yet — buyers would start with an empty value.</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className={"ncd-lever ncd-lever--edge" + (levering === "results" ? " on" : "")} title="Drag to resize results" onPointerDown={startLever("results")} />

      {/* ── results / release column ── */}
      <aside className="ncd-results" style={{ width: cols.results }}>
        <div className="ncd-res-head">
          <span className="ncd-res-title"><em>Results</em></span>
          <span className="ncd-res-stats">{groups.length} group{groups.length === 1 ? "" : "s"} · {outs.filter((o) => o.img).length} result{outs.filter((o) => o.img).length === 1 ? "" : "s"}</span>
          <span className="ncd-res-help" title="Every different mix of prompt text + variables gets its own group. Pick images from ONE group to publish.">?</span>
        </div>
        <div className="ncd-res-body">
          {groups.length === 0 && (
            <div className="ncd-res-empty">Renders appear here, grouped by prompt version — hit <b>Generate</b>.</div>
          )}
          {groups.map((g) => {
            const picked = g.outs.filter((o) => o.picked && o.img).length;
            return (
              <div key={g.con.sig} className="ncd-group" style={{ borderColor: g.pal.bar }}>
                <div className="ncd-group-h" style={{ background: g.pal.soft, color: g.pal.ink }}>
                  <span className="ncd-vdot" style={{ background: g.pal.bar }} />
                  <span className="ncd-group-name">{g.current ? "Current prompt" : "Prompt variant"}</span>
                  <span className="ncd-group-n">{g.outs.filter((o) => o.img).length}</span>
                  {picked > 0 && <span className="ncd-group-pick" style={{ background: g.pal.bar }}>{picked}/{releaseMin}</span>}
                </div>
                <div className="ncd-strip">
                  {g.outs.map((o) => (
                    <div key={o.id} className={"ncd-tile" + (o.picked ? " picked" : "")} style={o.picked ? { outlineColor: g.pal.bar } : undefined}>
                      {o.img ? (
                        <>
                          <img src={o.img} alt="render" draggable={false} onClick={() => api.openLightbox(o.id)} title="Open preview" />
                          <button className={"ncd-tile-pick" + (o.picked ? " on" : "")} style={o.picked ? { background: g.pal.bar } : undefined}
                            title={o.picked ? "Unpick" : "Pick for publishing (one group only)"}
                            onClick={() => api.togglePick(o.id)}>
                            {o.picked ? <Icon name="check" size={9} stroke={3.4} /> : null}
                          </button>
                        </>
                      ) : o.status === "loading" ? (
                        <span className="ncd-tile-load"><span className="ek-spinner" /></span>
                      ) : (
                        <span className="ncd-tile-empty">empty</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="ncd-res-release">
          <span className={"ncd-res-status" + (canRelease ? " ready" : "")}>
            {canRelease ? pickedOuts.length + " of " + releaseMin + " picked — ready" : pickedOuts.length + " of " + releaseMin + " picked · pick " + releaseMin + " from one group"}
          </span>
          <button className={"ncd-gen" + (canRelease ? "" : " disabled")} disabled={!canRelease} onClick={api.release}>
            <Icon name="sparkles" size={13} stroke={2.2} fill={canRelease ? "var(--cta-ink)" : "none"} /> Release
            {pickedOuts.length > 0 && <span className="ncd-gen-price">{pickedOuts.length}/{releaseMin}</span>}
          </button>
        </div>
      </aside>

      {/* ── remove-variable confirm ── */}
      {confirmDel && portalRoot && createPortal(
        <div className="ek-modal-scrim" style={{ zIndex: 1400 }} onClick={() => setConfirmDel(null)}>
          <div className="ek-modal" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="ek-modal-head">
              <span className="ek-sheet-bolt"><Icon name="trash" size={16} stroke={2} /></span>
              <div className="ek-modal-title">Remove this variable?</div>
              <button className="ek-modal-x" onClick={() => setConfirmDel(null)} aria-label="Keep the variable"><Icon name="x" size={16} stroke={2} /></button>
            </div>
            <div className="ek-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "var(--enki-ink-2)" }}>
                “{confirmDel.name}” stops being a variable.{" "}
                {((confirmDel.kind === "bool" ? confirmDel.str : confirmDel.value) ?? "").trim()
                  ? "Its default value takes its place in the prompt text."
                  : "Its name stays in the prompt text as plain words."}
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="ek-btn-2" style={{ minHeight: 38, width: "auto", padding: "0 16px" }} onClick={() => setConfirmDel(null)}>Cancel</button>
                <button className="ek-btn" style={{ minHeight: 38, width: "auto", padding: "0 16px" }} onClick={confirmRemoveVar}>
                  <Icon name="trash" size={14} stroke={2} /> Remove variable
                </button>
              </div>
            </div>
          </div>
        </div>,
        portalRoot,
      )}
    </div>
  );
}
