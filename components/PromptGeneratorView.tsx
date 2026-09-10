"use client";

import { sessionAuthHeaders } from "@/lib/session-headers";
import { fetchGenerationQuote, authorizePaidGeneration, toModelFamily } from "@/lib/generation-checkout";
import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useToast } from "@/hooks/use-toast";
import { addCreation } from "@/lib/creations";
import {
  Star,
  Heart,
  Share2,
  Info,
  X,
  Copy,
  Check,
  Sparkles,
  Loader2,
  Bookmark,
  BookmarkCheck,
  Download,
  Image as ImageIcon,
  MessageSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Link2 as LinkIcon,
  Send,
  ArrowLeft,
  Braces,
  Type,
} from "lucide-react";
import "./prompt-generator.css";
import BoostToggle from "@/components/generation/BoostToggle";
import DiceButton from "@/components/DiceButton";
import { DICE_LIMITS, type DiceValue, type DiceVariable } from "@/lib/generation/variable-dice";
import { type ResolutionTier } from "@/lib/generation/resolution";
import { useGenerationCore } from "@/hooks/useGenerationCore";
import QualitySelect, { type Quality } from "@/components/generation/QualitySelect";
import { variableRange } from "@/lib/editor/selection-variable";
import RatioSelect from "@/components/generation/RatioSelect";
import { useBetaAccess } from "@/components/BetaGate";
import { createPortal } from "react-dom";
import { openCreator } from "@/lib/openCreator";

/* ── Types ── */
type VarType = "text" | "checkbox" | "single-select" | "multi-select" | "slider" | "radio";

interface VariableOption {
  visibleName: string;
  promptValue: string;
}

interface PromptVariable {
  id: string;
  name: string;
  label: string;
  description?: string;
  type: VarType;
  defaultValue?: string | number | boolean | string[];
  required?: boolean;
  position?: number;
  min?: number;
  max?: number;
  options?: VariableOption[];
  allowReferenceImage?: boolean;
}

interface ShowcaseImage {
  url: string;
  thumbnail?: string;
  isPrimary?: boolean;
}

interface Props {
  promptId: string;
  title?: string;
  artistName?: string;
  artistId?: string;
  imageUrl?: string;
  showcaseImages?: ShowcaseImage[];
  isFreeShowcase?: boolean;
}


/* Offered sizes are per ROUTE — the lists live in lib/generation/resolution.ts
   so every picker in the app reads the same answer. */

function getFavs(): string[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem("prompt-favorites") || "[]"); }
  catch { return []; }
}
function setFavs(ids: string[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem("prompt-favorites", JSON.stringify(ids));
}

/* ── Component ── */
export default function PromptGeneratorView({
  promptId,
  title: propTitle,
  artistName: propArtistName,
  artistId,
  imageUrl: propImageUrl,
  showcaseImages: propShowcaseImages = [],
  isFreeShowcase: propIsFree,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  /* Auth */
  const account = useActiveAccount();
  const { publicKey: solanaPublicKey } = useWallet();
  const { address: cdpAddress } = useCdpAddress();
  const userKey = useMemo(
    () => account?.address ?? solanaPublicKey?.toBase58() ?? cdpAddress ?? null,
    [account?.address, solanaPublicKey, cdpAddress]
  );

  /* State */
  const [vars, setVars] = useState<Record<string, string>>({});
  const [aspect, setAspect] = useState("4:5");
  const [resolution, setResolution] = useState("2K");
  const [generator, setGenerator] = useState("Nano Banana Pro");
  /* The gpt-image quality lever — the image UI simply had none, so a
     GPT-Image-2 buyer could never choose it here (Kev, 2026-08-22). Hidden
     for models without the parameter (QualitySelect available). */
  const [quality, setQuality] = useState<Quality>("medium");
  /* Real engagement for the badge row: the star badge carried a HARDCODED
     "4.9" (found 2026-08-22 while adding likes), and likes had landed in a
     pill this surface never renders. Rating from the comments stats, likes
     from the likes route, heart toggles. */
  const [engagement, setEngagement] = useState<{ avg: number | null; likes: number; mine: boolean }>({ avg: null, likes: 0, mine: false });
  useEffect(() => {
    if (!promptId) return;
    fetch(`/api/prompts/${encodeURIComponent(promptId)}/comments`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.stats) setEngagement((e) => ({ ...e, avg: d.stats.avgRating ?? null })); })
      .catch(() => {});
    fetch(`/api/prompts/${encodeURIComponent(promptId)}/likes`, { headers: { ...sessionAuthHeaders() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setEngagement((e) => ({ ...e, likes: d.count ?? 0, mine: !!d.mine })); })
      .catch(() => {});
  }, [promptId]);
  const [liking, setLiking] = useState(false);
  const toggleLike = useCallback(async () => {
    if (liking || !promptId) return;
    setLiking(true);
    try {
      const res = await fetch(`/api/prompts/${encodeURIComponent(promptId)}/likes`, {
        method: "POST", headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d) setEngagement((e) => ({ ...e, likes: d.count ?? 0, mine: !!d.mine }));
      else if (res.status === 401) toast({ title: "Sign in to like." });
      else toast({ title: "Couldn't save the like", description: d?.error, variant: "destructive" }); // a swallowed 503 read as "aint working" (Kev, 2026-08-23)
    } finally { setLiking(false); }
  }, [liking, promptId, toast]);
  const [refs, setRefs] = useState<string[]>([]);
  const [fav, setFav] = useState(false);
  /* Team-cookie browsing is looking around, not using: generation controls
     (generator, settings, dice, refs, history) disappear entirely, Generate
     greys out — a guest cannot pay for it — and bookmark hides because its
     function does not exist for guests (Kev, 2026-08-24). Same expression
     as EnkiHome's `authed`. */
  const { access, role } = useBetaAccess();
  const guest = !(access === "ok" && role !== "team");
  const [generating, setGenerating] = useState(false);
  // Same model on a priority host — faster, dearer, identical image.
  const [boost, setBoost] = useState(false);
  /* Only consulted below the 960px breakpoint, where the history is an
     overlay. Above it the panel is always in the layout and this is inert. */
  const [historyOpen, setHistoryOpen] = useState(false);

  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /* The lightbox holds a COLLECTION and a position in it, not a lone url, so
     the arrows and the keyboard can page through whatever was opened — the
     reference deck, the history, or the single result (Kev, 2026-08-19). */
  const [lightbox, setLightbox] = useState<{ urls: string[]; at: number } | null>(null);
  const openLightbox = useCallback((urls: string[], at: number) => {
    if (urls.length === 0) return;
    setLightbox({ urls, at: Math.max(0, Math.min(at, urls.length - 1)) });
  }, []);
  const stepLightbox = useCallback((dir: 1 | -1) => {
    setLightbox(lb => {
      if (!lb || lb.urls.length < 2) return lb;
      // Wrap rather than stop: on a deck of 4, going "right" from the last
      // one is a clearer "back to the first" than a dead arrow.
      const at = (lb.at + dir + lb.urls.length) % lb.urls.length;
      return { ...lb, at };
    });
  }, []);
  /* Fullscreen feel: every control (arrows, X, the thumb strip below, the
     history rail right) sleeps after 1s without mouse movement and wakes
     instantly on the first move (Kev, 2026-08-22). State + timer, imperative
     enough to never re-render per pixel: the class flips only on the
     shown/hidden edge. */
  const [lbAwake, setLbAwake] = useState(true);
  const lbIdleT = useRef<number | null>(null);
  const wakeLb = useCallback(() => {
    setLbAwake(true);
    if (lbIdleT.current) window.clearTimeout(lbIdleT.current);
    lbIdleT.current = window.setTimeout(() => setLbAwake(false), 1000);
  }, []);
  useEffect(() => {
    if (!lightbox) { if (lbIdleT.current) window.clearTimeout(lbIdleT.current); return; }
    wakeLb();
    return () => { if (lbIdleT.current) window.clearTimeout(lbIdleT.current); };
  }, [lightbox, wakeLb]);

  // Arrow keys page, Escape closes. Bound only while the lightbox is open so
  // the rest of the view keeps its own keyboard handling.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") { e.preventDefault(); stepLightbox(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); stepLightbox(-1); }
      else if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, stepLightbox]);
  const [activeThumb, setActiveThumb] = useState(0);
  const [thumbOffset, setThumbOffset] = useState(0);
  const [activeTab, setActiveTab] = useState<"comments" | "reviews">("comments");
  const [localHistory, setLocalHistory] = useState<string[]>([]);
  const [savedToGallery, setSavedToGallery] = useState(false);
  /* What the last generation actually measured, straight from the server.
     Not derived from the resolution the reader picked: on the free route those
     two disagree by design, and showing the request back as if it were the
     result is the lie this exists to end. */
  const [resultSize, setResultSize] = useState<{ w: number; h: number; asked: string } | null>(null);
  /* Set only by the server's own answer. Deriving it in the browser would mean
     a second count that can disagree with the one the route enforces. */
  const [freeQuota, setFreeQuota] = useState<{ used: number; limit: number; signIn: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* Fetch available models from DB */
  const { data: modelsData } = useQuery<Array<{ id?: string; name?: string; price?: number; allowed_ratios?: string[]; maxResolution?: string; boostAvailable?: boolean }>>({
    queryKey: ["/api/models"],
    queryFn: async () => {
      const res = await fetch("/api/models", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
  const GENERATORS = useMemo(() => {
    const fromDb = (modelsData ?? [])
      .map((m) => (typeof m.name === "string" ? m.name : ""))
      .filter(Boolean);
    return fromDb.length > 0
      ? fromDb
      : ["Nano Banana Pro", "Seedream 5.0 lite (coming soon)", "GPT-Image-2 (coming soon)"];
  }, [modelsData]);

  useEffect(() => {
    if (GENERATORS.length > 0 && !GENERATORS.includes(generator)) {
      setGenerator(GENERATORS[0]);
    }
  }, [GENERATORS, generator]);

  /* Fetch prompt */
  const { data: promptData, isLoading: loading } = useQuery<{
    prompt?: {
      _id?: string; id?: string; title?: string;
      type?: string; prompt_type?: string;
      is_free_showcase?: boolean; price?: number; tags?: string[];
      content?: string; created_at?: string; creator?: string;
      publicPromptText?: string; showcaseImages?: ShowcaseImage[];
      promptData?: { variables?: PromptVariable[] };
    };
  }>({
    queryKey: [`/api/prompts/${promptId}`],
    enabled: !!promptId,
  });

  const prompt = promptData?.prompt;
  const variables = useMemo(() => prompt?.promptData?.variables || [], [prompt]);
  const title = prompt?.title || propTitle || "Untitled Prompt";
  const artistName = propArtistName || "Unknown Artist";
  const isFree =
    prompt?.prompt_type === "showcase" ||
    prompt?.prompt_type === "free-prompt" ||
    prompt?.is_free_showcase === true ||
    propIsFree ||
    false;
  const price = prompt?.price ?? 0;
  const tags = prompt?.tags?.length ? prompt.tags : [];

  /* Sharing.
   *
   * The link is built from the CURRENT location rather than a hardcoded
   * origin, so a link copied on a preview deployment points at that preview
   * and not at production. /generator/{id} is used deliberately: it is the
   * standalone route, so a recipient who is not signed into the shell still
   * lands on the piece itself.
   */

  const [shareOpen, setShareOpen] = useState(false);
  /* Where the fixed-position share menu anchors, measured from the trigger
     on open. Fixed for the same reason as the dropdown panels: inside the
     panel the menu lost the stacking war against later positioned siblings
     and rendered BEHIND them (Kev, 2026-08-24, screenshot). */
  const shareBtnRef = useRef<HTMLButtonElement>(null);
  const [sharePos, setSharePos] = useState<{ top: number; right: number } | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  /* x402 copy feedback: the icon turns into a green check + "copied!" for 2s
     (Kev, 2026-08-24) — confirmation at the click, not in a corner toast. */
  const [agentCopied, setAgentCopied] = useState(false);
  const agentCopiedTimer = useRef<number | null>(null);
  const shareUrl = useMemo(
    () => (typeof window === "undefined" ? "" : `${window.location.origin}/generator/${promptId}`),
    [promptId]
  );
  /* Checked once on mount, not during render: navigator.share does not exist
     on the server, and reading it while rendering makes the first client paint
     disagree with the server's. */
  const [canNativeShare, setCanNativeShare] = useState(false);
  useEffect(() => { setCanNativeShare(typeof navigator !== "undefined" && !!navigator.share); }, []);

  const shareText = `${title} on Enki Art`;
  const xUrl = `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`;
  const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`;

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 1600);
    } catch {
      // Clipboard access can be refused outright; say so rather than showing a
      // tick for something that did not happen.
      toast({ title: "Could not copy", description: shareUrl });
    }
  }, [shareUrl, toast]);

  const nativeShare = useCallback(async () => {
    try {
      await navigator.share({ title, text: shareText, url: shareUrl });
    } catch {
      /* Dismissing the sheet rejects too. Nothing went wrong, so say nothing. */
    }
    setShareOpen(false);
  }, [title, shareText, shareUrl]);

  /* The real total, from the server's own arithmetic. boostedCost(price) was
     only ever the ARTIST price — it omitted model cost, platform fee and the
     network fee, so the button promised less than the charge. A paid prompt
     with no quote greys out rather than showing a number we invented. */
  const modelFamily = toModelFamily(generator);
  /* Pass the pick through — the checkout accepts 1K since 2026-08-22, and
     the old 4K-or-2K coercion silently rebooked every 1K pick as 2K (found
     by review). Unknown values still fall to the 2K default. */
  const quoteResolution = resolution === "1K" || resolution === "2K" || resolution === "4K" ? resolution : ("2K" as const);

  /* A model priced at 0 in the DB runs on the free provider (Kev,
     2026-08-12 — "den preis entfernen, falls free model verfügbar ist").
     There is nothing to quote and nothing to charge, so the whole payment
     path is skipped rather than quoted at zero: a quote of $0.00 would still
     build an intent, a nonce account and a signature request for a payment
     that moves nothing. */
  /* Resolved by the shared core (name, id, family slug or plain slug) — the
     exact-name find missed whenever the DB name and the stored string
     differed, and every miss silently fell back to a 2K ceiling: "still has
     only 1k and 2k" (Kev, 2026-08-22). */
  /* NO freeRoute clamp: the SELECTED model rules the options — pick
     GPT-Image-2 and you get its ten ratios, 1K-4K and the quality lever on
     every prompt (Kev, 2026-08-22: clamping the lists to Flux on showcase
     prompts hid exactly the settings he selected the model FOR). What the
     free route cannot deliver it clamps server-side, and resultSize reports
     what was actually measured. */
  const core = useGenerationCore(generator);
  const freeModel = core.entry?.price === 0;

  /* Free of charge ONLY when the chosen model costs nothing to run. A free
     PROMPT with a paid model still bills its model cost + fee (Kev,
     2026-08-24: "free prompts also gotta be paid by users, not us") — the
     quote/intent rails price it with a zero artist leg, so the flow is the
     paid one with the artist share simply absent. */
  const noCharge = freeModel;

  /* Which sizes this run can actually deliver, and a pick that never survives
     outside that list. Without the correction a buyer who chose 4K and then
     switched to the free generator kept a 4K selection that the free route
     silently rendered at 0.59 MP. */
  /* Both lists come from /api/models rows — the same capability answers the
     server enforces. Free runs render on the free route, so they get the
     free model's ceiling; paid runs get the chosen model's. The literals
     these replace (ASPECTS, FREE_TIERS/PAID_TIERS) are how "2K/4K but never
     1K" and a six-ratio list survived here (Kev, 2026-08-22: "derive all
     these ratio und auflösungseinstellungen from the database!"). */
  const aspects = core.ratios;
  const resolutions = useMemo(() => core.tiers.map((t) => t.tier), [core]);
  useEffect(() => {
    if (!aspects.includes(aspect)) setAspect(aspects[0]);
  }, [aspects, aspect]);
  useEffect(() => {
    if (!resolutions.includes(resolution as ResolutionTier)) {
      setResolution(resolutions[resolutions.length - 1]);
    }
  }, [resolutions, resolution]);

  const { data: paidQuote } = useQuery({
    /* boost + quality are part of the key: toggling either MUST refetch, or
       the shown price is the old route's (Kev, 2026-08-23: boost = real cost
       everywhere). */
    queryKey: ["generation-quote", promptId, modelFamily, quoteResolution, boost, quality],
    queryFn: () =>
      fetchGenerationQuote({ promptId: promptId!, modelFamily, resolution: quoteResolution, boost, quality }),
    enabled: !noCharge && !!promptId && !loading,
    // Quotes expire server-side after 5 minutes; refresh a little sooner.
    refetchInterval: 4 * 60 * 1000,
  });
  const showcaseImages = prompt?.showcaseImages?.length ? prompt.showcaseImages : propShowcaseImages;
  const mainImage = showcaseImages[0]?.thumbnail || showcaseImages[0]?.url || propImageUrl || "";
  const promptText = prompt?.publicPromptText || "";

  /* The prompt, split into text and the variables embedded in it.
   *
   * A token is only a token when a variable of that name actually exists.
   * Prompt text contains ordinary brackets too, and turning "[sic]" into a
   * button that writes nowhere would be a control that lies about what it
   * does. Unknown brackets stay plain text.
   */
  /* Which form the sentence is shown in. "variables" is the default because
     it is what the text IS — the values are this reader's copy of it, and
     starting on those would hide the thing the artist actually wrote. */
  const [promptView, setPromptView] = useState<"variables" | "contents">("variables");
  /* The reader's own wording, or null while they have not touched it. Not ""
     as the untouched value: an empty string is a deliberate edit and has to
     survive as one. */
  const [editedPrompt, setEditedPrompt] = useState<string | null>(null);
  /* "+ Variable" on a selection in YOUR copy of the prompt — the same
     deferred-and-verified pattern as the editors, on the same shared
     validation (Kev, 2026-08-22: the pill belongs in every editor).
     Buyer-made [tokens] get inputs below the textarea and are substituted
     at generation; without that a fresh token would ship literally. */
  const editTaRef = useRef<HTMLTextAreaElement>(null);
  const [editPill, setEditPill] = useState<{ x: number; y: number; start: number; end: number } | null>(null);
  // The agent field's controlled open state — animated both ways.
  const [agentOpen, setAgentOpen] = useState(false);
  const editPillT = useRef<number | null>(null);
  useEffect(() => () => { if (editPillT.current) window.clearTimeout(editPillT.current); }, []);
  useEffect(() => {
    const onSel = () => {
      setEditPill((p) => {
        if (!p) return p;
        const ta = editTaRef.current;
        return !ta || document.activeElement !== ta || ta.selectionStart === ta.selectionEnd ? null : p;
      });
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);
  const scheduleEditPill = (e: { clientX?: number; clientY?: number }) => {
    const cx = e.clientX, cy = e.clientY;
    if (editPillT.current) window.clearTimeout(editPillT.current);
    editPillT.current = window.setTimeout(() => {
      editPillT.current = null;
      const ta = editTaRef.current; const box = ta?.parentElement;
      if (!ta || !box || document.activeElement !== ta) { setEditPill(null); return; }
      if (!variableRange(ta.value, ta.selectionStart, ta.selectionEnd)) { setEditPill(null); return; }
      const r = box.getBoundingClientRect();
      const x = Math.max(8, Math.min((cx ?? r.left + 80) - r.left - 56, r.width - 130));
      const y = (cy ?? r.top + 40) - r.top + 18;
      setEditPill({ x, y, start: ta.selectionStart, end: ta.selectionEnd });
    }, 80);
  };
  const addVariableFromEditSel = () => {
    const pill = editPill;
    setEditPill(null);
    if (!pill || editedPrompt === null) return;
    const r = variableRange(editedPrompt, pill.start, pill.end);
    if (!r) return;
    setEditedPrompt(editedPrompt.slice(0, r.start) + "[" + r.name + "]" + editedPrompt.slice(r.end));
    requestAnimationFrame(() => {
      const ta = editTaRef.current; const caret = r.start + r.name.length + 2;
      if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); }
    });
  };
  /* The buyer's own [tokens], inferred from the edited text. */
  const localTokens = useMemo(() => {
    if (editedPrompt === null) return [] as string[];
    return [...new Set([...editedPrompt.matchAll(/\[([^\]\n]+)\]/g)].map((m) => m[1]))];
  }, [editedPrompt]);
  /* Per-slot deviations from the slider. The slider is the whole sentence,
     these are the exceptions — so flipping one word does not fight the global
     control, and moving the slider clears them because that is a statement
     about the whole thing. */
  const [tokenOverrides, setTokenOverrides] = useState<Record<string, boolean>>({});
  const [editingVar, setEditingVar] = useState<string | null>(null);
  const shownAsValue = useCallback(
    (name: string) => tokenOverrides[name] ?? promptView === "contents",
    [tokenOverrides, promptView]
  );
  const toggleToken = useCallback(
    (name: string) => setTokenOverrides(o => ({ ...o, [name]: !(o[name] ?? promptView === "contents") })),
    [promptView]
  );
  const setView = useCallback((v: "variables" | "contents") => {
    setPromptView(v);
    setTokenOverrides({});
  }, []);
  const promptSegments = useMemo(() => {
    /* Tokens resolve the way the author side STORES names, not literally.
       The editor writes the token exactly as the artist typed it —
       "[Character Design]" — while app/api/prompt/route.ts slugs the stored
       name to satisfy chk_var_name_format (^[a-z][a-z0-9_]*$): lowercased,
       every non-alphanumeric run collapsed to an underscore. An exact lookup
       therefore misses every name that is not already one lowercase word, and
       the slot renders as dead literal text — which is exactly the case an
       artist hits when they name a part "character design".

       Each variable is indexed under its stored name, that name's slug, and
       its LABEL's slug. The label is kept verbatim by the same route, so it
       is the only key that still matches when the slug gained a prefix
       ("2nd subject" -> name v_2nd_subject, label "2nd subject"). */
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    const byName = new Map<string, PromptVariable>();
    for (const v of variables) {
      for (const k of [v.name, slug(v.name), v.label ? slug(v.label) : ""]) {
        if (k && !byName.has(k)) byName.set(k, v);
      }
    }
    const out: Array<{ text: string; variable?: PromptVariable }> = [];
    let last = 0;
    for (const m of (promptText || "").matchAll(/\[([^\]\n]+)\]/g)) {
      const v = byName.get(m[1]) ?? byName.get(slug(m[1]));
      if (!v) continue;
      if (m.index! > last) out.push({ text: (promptText || "").slice(last, m.index) });
      out.push({ text: m[0], variable: v });
      last = m.index! + m[0].length;
    }
    if (last < (promptText || "").length) out.push({ text: (promptText || "").slice(last) });
    return out;
  }, [promptText, variables]);

  /* The variable whose full control is showing, if any. Resolved from the
     name rather than stored as an object so it cannot go stale when the
     prompt reloads and hands back fresh variable objects. */

  /* What Copy puts on the clipboard: exactly what is on screen.
     In "variables" that is the artist's text with its slots intact, which is
     the form worth reusing. In "contents" it is this reader's filled-in
     version. Copying one while showing the other is the kind of quiet
     mismatch nobody notices until they paste it somewhere. */
  const promptForClipboard = useMemo(() => {
    /* An edit wins over everything below it. Once the reader has changed the
       wording, re-deriving from the slots would quietly throw their sentence
       away the next time a variable changed. null means "not edited" — an
       empty string is a deliberate edit and must survive. */
    if (editedPrompt !== null) return editedPrompt;
    /* Reads the SAME per-slot state the eye does, so Copy and Generate can
       never take a different sentence from the one on screen — including when
       individual slots have been flipped against the slider. */
    return promptSegments
      .map(seg =>
        seg.variable
          ? shownAsValue(seg.variable.name) && vars[seg.variable.name]
            ? vars[seg.variable.name]
            : `[${seg.variable.name}]`
          : seg.text
      )
      .join("");
  }, [promptSegments, vars, editedPrompt, shownAsValue]);

  /* Fetch user's generations — API returns { data: { generations, total } } via createSuccessResponse */
  const genQueryKey = ["user-generations", userKey, promptId];
  const { data: genData } = useQuery<{
    data?: { generations?: Array<{ id: string; image_urls?: string[]; created_at: string; prompt_id?: string }> };
    generations?: Array<{ id: string; image_urls?: string[]; created_at: string; prompt_id?: string }>;
  }>({
    queryKey: genQueryKey,
    queryFn: async () => {
      if (!userKey) return {};
      const res = await fetch(`/api/generations?userId=${encodeURIComponent(userKey)}&limit=20`);
      return res.ok ? res.json() : {};
    },
    enabled: !!userKey,
    staleTime: 30_000,
  });

  const dbHistory = useMemo(() => {
    const gens = genData?.data?.generations ?? genData?.generations ?? [];
    return (gens as Array<{ id: string; image_urls?: string[]; created_at: string }>)
      .filter(g => g.image_urls?.length)
      .flatMap(g => g.image_urls as string[]);
  }, [genData]);

  /* Merge local (immediate) + DB history, deduplicate, cap at 20 */
  const history = useMemo(() => {
    const seen = new Set<string>();
    return [...localHistory, ...dbHistory].filter(url => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    }).slice(0, 20);
  }, [localHistory, dbHistory]);

  /* Init */
  useEffect(() => { setFav(getFavs().includes(promptId)); }, [promptId]);
  useEffect(() => {
    if (variables.length) {
      const init: Record<string, string> = {};
      variables.forEach(v => {
        if (v.type === "checkbox") {
          init[v.name] = v.defaultValue ? "true" : "false";
        } else if (v.type === "slider") {
          init[v.name] = String(v.defaultValue ?? v.min ?? 0);
        } else if (v.type === "single-select" || v.type === "radio") {
          const defOpt = v.options?.[0]?.promptValue ?? "";
          init[v.name] = v.defaultValue != null ? String(v.defaultValue) : defOpt;
        } else if (v.type === "multi-select") {
          init[v.name] = "";
        } else {
          init[v.name] = v.defaultValue != null ? String(v.defaultValue) : "";
        }
      });
      setVars(init);
    }
  }, [variables]);

  /* Handlers */
  const toggleFav = useCallback(() => {
    const list = getFavs();
    setFavs(fav ? list.filter(id => id !== promptId) : [...list, promptId]);
    setFav(p => !p);
    toast({ title: fav ? "Removed from favorites" : "Saved to favorites" });
  }, [fav, promptId, toast]);

  /* Copies WHAT IS SHOWN — slots in "variables", filled values in
     "contents" — rather than always the raw text. Copying one form while
     displaying the other is a mismatch nobody notices until they paste it. */
  const copyPrompt = useCallback(() => {
    const text = promptForClipboard || promptText;
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [promptForClipboard, promptText]);

  const onRefUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const remaining = 10 - refs.length;
    Array.from(files).slice(0, remaining).forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => setRefs(prev => prev.length >= 10 ? prev : [...prev, ev.target?.result as string]);
      reader.readAsDataURL(file);
    });
    if (fileRef.current) fileRef.current.value = "";
  }, [refs.length]);

  const removeRef = useCallback((i: number) => setRefs(prev => prev.filter((_, idx) => idx !== i)), []);

  /* How much of each buried reference card stays visible.
   *
   * The deck must fit on ONE line inside a fixed 230px sidebar that clips
   * horizontally (.pgv-sidebar has overflow: hidden, .pgv-sidebar-scroll has
   * overflow-x: hidden), so a deck that overruns does not scroll — the last
   * cards simply vanish. Measured budget for the deck itself is 155px: 201px
   * of block content, minus the 36px add-tile and the 10px gap.
   *
   * So the strip is derived from the count rather than fixed: ten images pack
   * to 13px each (36 + 9x13 = 153), six or fewer get the comfortable 20px.
   * The badge width is the same value, so the ordinal always sits exactly on
   * the part of the card that is not covered by its neighbour — and the drop
   * seam below splits on the middle of that same strip.
   */
  const refStrip = useMemo(() => {
    const DECK_PX = 155;
    const TILE_PX = 36;
    if (refs.length < 2) return 20;
    return Math.min(20, Math.floor((DECK_PX - TILE_PX) / (refs.length - 1)));
  }, [refs.length]);

  /* Reorder by dragging a card onto another position.
   *
   * The numbers on the deck are not labels, they are the order the images are
   * sent in, and a prompt refers to them by that position. Without this the
   * only way to fix an upload that landed in the wrong order is to delete the
   * images and add them again. The editor deck has had this from the start
   * (NodeCreator's moveRef); this is the buyer side catching up.
   */
  const [refDragI, setRefDragI] = useState<number | null>(null);
  /* The seam the pointer is currently aiming at, as an insertion index into
   * the deck as it stands (0 = before the first card, refs.length = past the
   * last). Tracking the SEAM rather than the hovered card is what makes the
   * feedback honest: it follows the cursor across each card's midpoint, and
   * it does not depend on which side the drag started from. */
  const [refSeam, setRefSeam] = useState<number | null>(null);

  const moveRef = useCallback((from: number, to: number) => {
    if (from === to) return;
    setRefs(prev => {
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const endRefDrag = useCallback(() => {
    setRefDragI(null);
    setRefSeam(null);
  }, []);

  /* Which seam to draw the gap at.
   *
   * Nothing is drawn for the two seams either side of the carried card,
   * because dropping there moves nothing: promising a change and then not
   * making one is worse than showing no marker at all.
   */
  const refGapAt = useMemo(() => {
    if (refDragI === null || refSeam === null) return -1;
    if (refSeam === refDragI || refSeam === refDragI + 1) return -1;
    return refSeam;
  }, [refDragI, refSeam]);

  /* The deck's geometry as it stood when the drag STARTED.
   *
   * This has to be a snapshot, not a live measurement, or the indicator
   * oscillates and the user sees nothing settle. Opening the gap moves every
   * card behind it to the right; measuring live would then put a different
   * card under a stationary cursor, which flips the seam, which moves the gap
   * back, which flips it again. The seam has to be a function of the pointer
   * alone, and the pointer is not moved by our own reflow.
   */
  const refGeom = useRef<{ lefts: number[]; strip: number; lastRight: number } | null>(null);

  const captureRefGeometry = useCallback((deck: Element | null) => {
    if (!deck) return;
    const cards = [...deck.querySelectorAll<HTMLElement>(".pgv-ref-slot")];
    if (cards.length === 0) return;
    const last = cards[cards.length - 1].getBoundingClientRect();
    refGeom.current = {
      lefts: cards.map((c) => c.getBoundingClientRect().left),
      strip: refStrip,
      lastRight: last.right,
    };
  }, [refStrip]);

  /* Which seam the pointer is over, from its x against the midpoint of the
   * part of each card the user can actually SEE.
   *
   * Not the midpoint of the card's box: cards overlap, so all but the last
   * show only their leftmost strip and the rest lies buried under their
   * neighbours. Splitting on box midpoints would flip the seam at a point
   * sitting under a different card entirely, and the marker would appear
   * somewhere the cursor is not.
   */
  const seamFromX = useCallback((clientX: number): number | null => {
    const g = refGeom.current;
    if (!g) return null;
    for (let i = 0; i < g.lefts.length; i++) {
      const visible = i === g.lefts.length - 1 ? g.lastRight - g.lefts[i] : g.strip;
      if (clientX < g.lefts[i] + visible / 2) return i;
    }
    return g.lefts.length;
  }, []);

  const onVarChange = useCallback((name: string, value: string) => {
    setVars(prev => ({ ...prev, [name]: value }));
  }, []);

  // This surface keys `vars` by variable NAME, so name is the dice id — the
  // promptId path makes the server load the authoritative definitions from
  // prompt_variables and key its reply by name too.
  const diceVariables = useMemo<DiceVariable[]>(
    () =>
      variables.map((v) => ({
        id: v.name,
        name: v.name,
        label: v.label,
        description: v.description || undefined,
        // radio is a pick-one control; the dice knows it as single-select
        type: v.type === "radio" ? "single-select" : v.type,
        options: v.options,
        min: v.min,
        max: v.max,
      })),
    [variables]
  );

  /* Fill the gaps, never overwrite a decision.
   *
   * On this surface the dice is a helper for the fields the buyer left empty,
   * not a reset button. Someone who typed "brass, heavily tarnished" into one
   * field and wants the rest invented would otherwise lose that sentence on
   * the click that was supposed to help them, with no undo anywhere on the
   * page. So an existing value wins over a rolled one, always.
   *
   * The roll itself still covers every variable: on the promptId path the
   * server loads the definitions and rolls a COHERENT set, so it has to see
   * the whole picture. Narrowing the request would buy nothing and cost the
   * coherence. The filtering belongs here, at the point of application.
   *
   * `vars` stores every value as a string (checkbox "true"/"false",
   * multi-select comma-joined), so encode to match.
   */
  const applyDiceValues = useCallback((values: Record<string, DiceValue>) => {
    setVars((prev) => {
      const next = { ...prev };
      for (const [name, value] of Object.entries(values)) {
        if (typeof prev[name] === "string" && prev[name].trim() !== "") continue;
        next[name] = Array.isArray(value) ? value.join(",") : String(value);
      }
      return next;
    });
  }, []);

  const generate = useCallback(async () => {
    setGenerating(true);
    setResultUrl(null);
    try {
      /* 1. Build final prompt text */
      // Resolve each variable's raw string value → prompt value
      const resolvedVars: Record<string, string> = {};
      variables.forEach(v => {
        const raw = vars[v.name] ?? "";
        if (v.type === "checkbox") {
          // checkbox: if true, use label as prompt value; if false, use empty
          resolvedVars[v.name] = raw === "true" ? (v.label || v.name) : "";
        } else if (v.type === "multi-select" && v.options) {
          // multi-select: raw is comma-joined promptValues already
          resolvedVars[v.name] = raw;
        } else if ((v.type === "single-select" || v.type === "radio") && v.options) {
          // single-select/radio: raw IS the promptValue already
          resolvedVars[v.name] = raw;
        } else {
          resolvedVars[v.name] = raw;
        }
      });

      let final = "";
      if (isFree && editedPrompt !== null) {
        /* The reader rewrote it, so send exactly that. Running the slot
           substitution over their sentence again would edit words they chose
           themselves — and silently, since the result still looks plausible. */
        /* Buyer-made [tokens] resolve from the same vars store their inputs
           write to; an unfilled token ships literally so nothing vanishes. */
        final = editedPrompt.replace(/\[([^\]\n]+)\]/g, (m, name) => vars[name] || m);
      } else if (isFree && promptText) {
        /* Assembled from the SAME segments the sentence renders, so a token
           the reader saw resolve is a token that gets substituted. This used
           to rebuild the text by regex from the STORED slug — /\[character_
           design\]/i — which cannot match the "[Character Design]" actually
           written in the prompt body, so every multi-word name shipped its
           raw bracket to the image model as literal words. */
        final = promptSegments
          .map(s => (s.variable ? resolvedVars[s.variable.name] || s.text : s.text))
          .join("");
      } else {
        final = title || "A beautiful artistic image";
        const filled = Object.entries(resolvedVars)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        if (filled) final = `${final}, ${filled}`;
      }

      /* 2. Generate image.

         Paid prompts hold a payment FIRST — intent → authorize → sign in the
         buyer's wallet → submit — and generate with the intentId; the server
         captures only after the image is stored, and voids on any failure, so
         no branch of this function can end with money gone and no picture.
         This surface previously displayed a price and then called the FREE
         route: the marketplace showed prices and never charged anyone. */
      let res: Response;
      if (!noCharge && promptId) {
        const { intentId } = await authorizePaidGeneration({
          promptId,
          modelFamily,
          resolution: quoteResolution,
          boost,
          quality,
        });
        res = await fetch("/api/generate-image", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
          body: JSON.stringify({ intentId, prompt: final.trim(), aspectRatio: aspect, quality }),
        });
      } else {
        res = await fetch("/api/generate-free", {
          method: "POST",
          /* The session travels with a FREE generation too. Without it
             resolveRecordingUserId returns null and the route skips its whole
             recorder block, so a signed-in user's free images belonged to
             nobody and never reached their history. */
          headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
          /* promptId travels even when the wording was edited: the image is
             still that prompt's descendant, and without it the record said the
             generation came from nowhere. */
          body: JSON.stringify({ prompt: final.trim(), aspectRatio: aspect, resolution, promptId, quality }),
        });
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        /* The free allowance is a state, not a failure. A red "Generation
           Failed" toast that vanishes would leave the reader pressing the
           button again, so it is kept on screen next to the button instead. */
        if (res.status === 401 && d?.signInRequired) {
          setFreeQuota({ used: 0, limit: 0, signIn: true });
          return;
        }
        if (res.status === 402 && d?.freeQuotaExhausted) {
          setFreeQuota({ used: Number(d.used) || 0, limit: Number(d.limit) || 0, signIn: false });
          return;
        }
        throw new Error(d.error || "Generation failed");
      }
      const data = await res.json();
      if (!data.imageUrl) throw new Error("No image returned");
      setResultUrl(data.imageUrl);
      setResultSize(
        typeof data.width === "number" && typeof data.height === "number"
          ? { w: data.width, h: data.height, asked: String(data.requestedResolution ?? resolution) }
          : null,
      );
      setSavedToGallery(false);
      /* Immediately add to local history so it shows up regardless of auth type */
      setLocalHistory(prev => [data.imageUrl, ...prev].slice(0, 20));
      setActiveThumb(0);

      /* 3. Persist to local gallery */
      if (userKey) {
        addCreation(userKey, { id: `gen-${Date.now()}`, imageUrl: data.imageUrl, prompt: final, createdAt: new Date().toISOString() });
        window.dispatchEvent(new Event("gallery-refresh"));
      }

      /* 4. Persist to Supabase: POST record, then PATCH image_urls */
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (userKey && isUuid.test(userKey)) {
        try {
          const postRes = await fetch("/api/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: userKey,
              promptId,
              encryptedPrompt: final,
              variableValues: Object.entries(vars).map(([k, v]) => ({ variableName: k, value: v })),
              settings: { aspectRatio: aspect, resolution, referenceImageCount: refs.length },
              boost,
            }),
          });
          if (postRes.ok) {
            const postData = await postRes.json();
            const genId = postData?.data?.generationId ?? postData?.generationId;
            if (genId) {
              /* PATCH image_urls + mark completed */
              await fetch(`/api/generations/${genId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
                body: JSON.stringify({
                  status: "completed",
                  imageUrls: [data.imageUrl],
                  completedAt: new Date().toISOString(),
                }),
              });
            }
          }
        } catch { /* non-critical */ }
        /* Refetch history panel */
        queryClient.invalidateQueries({ queryKey: genQueryKey });
      }

      toast({ title: "Image Generated!", description: `Generated using ${data.provider || "AI"}` });
    } catch (e: any) {
      toast({ title: "Generation Failed", description: e.message, variant: "destructive" });
    } finally { setGenerating(false); }
    /* editedPrompt belongs here. Without it this callback keeps the value from
       the render that created it — null — so a reader could rewrite the prompt,
       press Generate, and receive the ARTIST'S wording instead of their own,
       with nothing on screen explaining why. Caught by intercepting the request
       body rather than by watching the picture, which would have looked like a
       plausible result either way. */
    /* variables and promptSegments are read in the body and were both absent
       here: the callback kept whichever list it closed over on first render,
       so a prompt whose variables arrived after it would have generated from
       an empty set. Same class of bug as the edited-prompt one this component
       already carried. */
  }, [isFree, noCharge, modelFamily, quoteResolution, promptText, editedPrompt, vars, variables, promptSegments, title, aspect, resolution, userKey, promptId, refs.length, toast, queryClient, genQueryKey]);

  const download = useCallback(() => {
    if (!resultUrl) return;
    const a = document.createElement("a");
    a.href = resultUrl; a.download = `generated-${Date.now()}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }, [resultUrl]);

  if (loading) {
    return (
      <div className="pgv-page">
        {/* Spinner only, dead center — the text sat mid-left inside the
            panel because the box centered against 100vh, not the visible
            area (Kev, 2026-08-22). */}
        <div className="pgv-loading" role="status" aria-label="Loading"><Loader2 size={26} className="pgv-spinner" /></div>
      </div>
    );
  }

  const displayImage = resultUrl || mainImage;
  const allImages = resultUrl
    ? [{ url: resultUrl, thumbnail: resultUrl }, ...showcaseImages]
    : showcaseImages;
  const visibleThumbs = allImages.slice(thumbOffset, thumbOffset + 6);

  /* One rendering of a variable, used by BOTH surfaces.
   * Paid prompts list every variable; a free prompt shows the one the reader
   * clicked in the sentence. Two copies of this markup would drift the moment
   * a new variable type is added, and only one of the two would get it.
   */
  const renderVariable = (v: PromptVariable) => (
            <div key={v.id || v.name} className="pgv-block">
              <span className="pgv-section-label">{v.label || v.name}</span>

              {/* TEXT */}
              {v.type === "text" && (
                <input
                  className="pgv-input"
                  value={vars[v.name] || ""}
                  onChange={e => onVarChange(v.name, e.target.value)}
                  placeholder={v.defaultValue ? String(v.defaultValue) : `Enter ${(v.label || v.name).toLowerCase()}…`}
                />
              )}

              {/* CHECKBOX */}
              {v.type === "checkbox" && (
                <label className="pgv-check-row">
                  <input
                    type="checkbox"
                    checked={vars[v.name] === "true"}
                    onChange={e => onVarChange(v.name, e.target.checked ? "true" : "false")}
                  />
                  {v.description || v.label}
                </label>
              )}

              {/* SINGLE-SELECT */}
              {v.type === "single-select" && v.options && (
                <select
                  className="pgv-generator-select"
                  value={vars[v.name] || ""}
                  onChange={e => onVarChange(v.name, e.target.value)}
                >
                  {v.options.map((opt, i) => (
                    <option key={i} value={opt.promptValue}>{opt.visibleName}</option>
                  ))}
                </select>
              )}

              {/* RADIO */}
              {v.type === "radio" && v.options && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                  {v.options.map((opt, i) => (
                    <label key={i} className="pgv-check-row">
                      <input
                        type="radio"
                        name={v.name}
                        value={opt.promptValue}
                        checked={vars[v.name] === opt.promptValue}
                        onChange={() => onVarChange(v.name, opt.promptValue)}
                        style={{ accentColor: "var(--pgv-accent)" }}
                      />
                      {opt.visibleName}
                    </label>
                  ))}
                </div>
              )}

              {/* MULTI-SELECT */}
              {v.type === "multi-select" && v.options && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                  {v.options.map((opt, i) => {
                    const selected = (vars[v.name] || "").split(",").filter(Boolean);
                    const checked = selected.includes(opt.promptValue);
                    return (
                      <label key={i} className="pgv-check-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={e => {
                            const next = e.target.checked
                              ? [...selected, opt.promptValue]
                              : selected.filter(s => s !== opt.promptValue);
                            onVarChange(v.name, next.join(","));
                          }}
                        />
                        {opt.visibleName}
                      </label>
                    );
                  })}
                </div>
              )}

              {/* SLIDER */}
              {v.type === "slider" && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#888", marginBottom: 4 }}>
                    <span>{v.min ?? 0}</span>
                    <span style={{ color: "#ddd", fontWeight: 600 }}>{vars[v.name] ?? v.defaultValue ?? v.min ?? 0}</span>
                    <span>{v.max ?? 100}</span>
                  </div>
                  <input
                    type="range"
                    min={v.min ?? 0}
                    max={v.max ?? 100}
                    step={1}
                    value={Number(vars[v.name] ?? v.defaultValue ?? v.min ?? 0)}
                    onChange={e => onVarChange(v.name, e.target.value)}
                    style={{ width: "100%", accentColor: "var(--pgv-accent)" }}
                  />
                </div>
              )}
            </div>
  );
  return (
    <div className="pgv-page">
      {/* ═══ LEFT SIDEBAR ═══ */}
      <aside className="pgv-sidebar">
        {/* Title + meta */}
        <div className="pgv-sidebar-header">
            {/* A small way back, directly above the title. Kev asked for it
                "very small to save space": the header is the top of a 230px
                column, so a full-width Back row would cost a line that the
                prompt and its variables need more.

                Opened as an overlay it closes the overlay, which leaves the
                feed exactly where it was. On the standalone /generator route
                there is no overlay to close, so it steps back through history
                instead — same gesture, same result, whichever way the reader
                arrived. */}
            <button
              className="pgv-back"
              type="button"
              aria-label="Back"
              title="Back"
              onClick={() => {
                if (document.querySelector(".pgv-detail-panel")) {
                  window.dispatchEvent(new CustomEvent("enki:close-detail"));
                } else {
                  window.history.back();
                }
              }}
            >
              <ArrowLeft size={13} />
            </button>
            <h1>{title}</h1>
            {/* The artist, under the title, reachable. A marketplace whose
                creator is unclickable makes every piece look like stock. When
                there is no id to link to, the name is plain text rather than a
                link that goes nowhere. */}
            {artistId ? (
              <a className="pgv-artist" href={`/creators/${artistId}`}
                onClick={(e) => { e.preventDefault(); openCreator(artistId); }}>{artistName}</a>
            ) : (
              <span className="pgv-artist pgv-artist--plain">{artistName}</span>
            )}
            <div className="pgv-meta-row">
              <span className="pgv-star-badge" title="Rating"><Star size={11} fill={engagement.avg ? "currentColor" : "none"} /> {engagement.avg ?? "–"}</span>
              {/* Likes to the RIGHT of the rating (Kev, 2026-08-22). */}
              <button type="button" className="pgv-star-badge pgv-like-badge" title={engagement.mine ? "Unlike" : "Like"} onClick={() => void toggleLike()}>
                <Heart size={11} fill={engagement.mine ? "currentColor" : "none"} /> {engagement.likes}
              </button>
              {/* Mini download button — hands over the CURRENT image
                  (result if one exists, else the showcase original).
                  Cross-origin CDNs can refuse a scripted fetch; then the
                  image opens in a tab instead of failing silently. */}
              <button
                className="pgv-icon-btn"
                aria-label="Download image"
                title="Download image"
                disabled={!displayImage}
                onClick={async () => {
                  if (!displayImage) return;
                  try {
                    const blob = await (await fetch(displayImage)).blob();
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = `${title.replace(/[^\w\- ]+/g, "").trim() || "enki-image"}.jpg`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  } catch {
                    window.open(displayImage, "_blank", "noopener");
                  }
                }}
              >
                <Download size={13} />
              </button>
              <div className="pgv-share">
                <button
                  ref={shareBtnRef}
                  className="pgv-icon-btn"
                  aria-label="Share"
                  aria-expanded={shareOpen}
                  title="Share"
                  onClick={() => {
                    if (!shareOpen) {
                      const r = shareBtnRef.current?.getBoundingClientRect();
                      if (r) setSharePos({ top: r.bottom + 6, right: window.innerWidth - r.right });
                    }
                    setShareOpen(v => !v);
                  }}
                >
                  <Share2 size={12} />
                </button>
                {shareOpen && createPortal(
                  <>
                    {/* A click anywhere else closes it — a menu you can only
                        dismiss by hitting the same small button again is a
                        menu people leave open. PORTALED to body: the detail
                        panel is a stacking context UNDER the shell rail
                        (162 vs 163+), so from inside it no z-index could
                        keep the menu above the left menu (Kev, 2026-08-24,
                        screenshot). */}
                    <div className="pgv-share-scrim" onClick={() => setShareOpen(false)} />
                    <div className="pgv-share-menu" role="menu"
                      style={sharePos ? { top: sharePos.top, right: sharePos.right } : undefined}>
                      <button role="menuitem" onClick={copyLink}>
                        {copiedLink ? <Check size={13} /> : <LinkIcon size={13} />}
                        {copiedLink ? "Link copied" : "Copy link"}
                      </button>
                      {canNativeShare ? (
                        /* On a phone this is the whole point: one sheet with
                           every app the reader actually has, including the
                           ones no web intent can reach. */
                        <button role="menuitem" onClick={nativeShare}>
                          <Share2 size={13} /> Share post via …
                        </button>
                      ) : (
                        /* Desktop has no such sheet, so the networks that
                           publish a real web intent are listed by name.
                           Instagram is deliberately absent: it has no share
                           intent for an arbitrary link, and an entry that
                           silently does nothing is worse than no entry. */
                        <>
                          <a role="menuitem" href={xUrl} target="_blank" rel="noreferrer" onClick={() => setShareOpen(false)}>
                            <Share2 size={13} /> Share on X
                          </a>
                          <a role="menuitem" href={tgUrl} target="_blank" rel="noreferrer" onClick={() => setShareOpen(false)}>
                            <Send size={13} /> Share on Telegram
                          </a>
                        </>
                      )}
                    </div>
                  </>,
                  document.body,
                )}
              </div>
              {/* Wired to toggleFav — it rendered without an onClick and
                  reacted to nothing. Hidden for guests: the function does
                  not exist for them, so neither does the button
                  (Kev, 2026-08-24). */}
              {!guest && (
                <button className="pgv-icon-btn" aria-label={fav ? "Remove bookmark" : "Bookmark"}
                  title={fav ? "Remove bookmark" : "Bookmark"} onClick={toggleFav}>
                  <Bookmark size={12} fill={fav ? "currentColor" : "none"} />
                </button>
              )}
            </div>
          </div>

          <div className="pgv-sidebar-scroll">
          {/* Free: the prompt IS the interface.
              A free prompt has nothing to hide, so the text is the thing worth
              showing — and its variables are edited IN it rather than in a
              stack of labelled boxes underneath that repeat what the sentence
              already says. Paid prompts keep the boxes: their text is not
              shown, so the boxes are the only place their variables exist. */}
          {isFree && promptText && (
            <div className="pgv-block">
              {/* Two views of one text, and the copy that follows whichever is
                  showing. VARIABLES gives the slots — [surface] — which is the
                  form an artist reads and reuses. CONTENTS gives the sentence
                  as it will be sent. Copy takes what is on screen, so there is
                  never a second guess about which version reached the
                  clipboard. */}
              <div className="pgv-prompt-head">
                <span className="pgv-section-label" style={{ marginBottom: 0 }}>Prompt · Free</span>
                {/* One control with two positions, not two buttons. Two
                    buttons read as two unrelated actions; a slider says these
                    are two views of the SAME text and that picking one puts
                    the other away. The thumb slides rather than jumping, which
                    is what makes the pair feel like one object. */}
                {variables.length > 0 && (
                  <div
                    className={`pgv-viewtoggle${promptView === "contents" ? " at-contents" : ""}`}
                    role="group"
                    aria-label="Prompt view"
                  >
                    <span className="pgv-viewtoggle-thumb" aria-hidden />
                    <button
                      type="button"
                      className={`pgv-viewtoggle-opt${promptView === "variables" ? " on" : ""}`}
                      onClick={() => setView("variables")}
                      aria-pressed={promptView === "variables"}
                      title="Show the variable slots"
                      aria-label="Show the variable slots"
                    >
                      <Braces size={12} />
                    </button>
                    <button
                      type="button"
                      className={`pgv-viewtoggle-opt${promptView === "contents" ? " on" : ""}`}
                      onClick={() => setView("contents")}
                      aria-pressed={promptView === "contents"}
                      title="Show the values that will be sent"
                      aria-label="Show the values that will be sent"
                    >
                      <Type size={12} />
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="pgv-mode pgv-mode--copy"
                  onClick={copyPrompt}
                  title="Copy this prompt"
                  aria-label="Copy this prompt"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>

              {/* VARIABLES is the artist's text and stays read-only — its
                  slots are the thing being shown, and they are clickable.
                  CONTENTS is YOUR copy of it, so it is a real textarea: type
                  in it, generate from it. The two views therefore also mean
                  "theirs" and "yours", which is why editing belongs on one and
                  not the other. */}
              {/* The slider moves ALL the slots at once; a click moves ONE.
                  So the two controls are the same gesture at two scales, and
                  a reader can hold most of the sentence in slot form while
                  reading one value in place — which is the state you are in
                  while deciding what that one word should be. */}
              {editedPrompt === null ? (
                <p className="pgv-prompt-live">
                  {promptSegments.map((seg, i) => {
                    if (!seg.variable) return <span key={`t-${i}`}>{seg.text}</span>;
                    const name = seg.variable.name;
                    const value = vars[name] || "";
                    const key = `${name}-${i}`;

                    if (editingVar === key) {
                      /* Edited IN the sentence — no popup (Kev). The field is
                         sized to its own content so the words around it do not
                         jump apart while typing. */
                      return (
                        <input
                          key={key}
                          autoFocus
                          className="pgv-tok-input"
                          value={value}
                          size={Math.max(6, value.length + 1)}
                          placeholder={name}
                          onChange={e => onVarChange(name, e.target.value)}
                          onBlur={() => setEditingVar(null)}
                          onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") setEditingVar(null); }}
                        />
                      );
                    }

                    return (
                      <button
                        key={key}
                        type="button"
                        className={`pgv-tok${value ? " filled" : ""}`}
                        /* Single click flips just this one between its name and
                           its value. Double click opens it for editing — the
                           two clicks it contains cancel each other out, so the
                           slot is left in whatever form you double-clicked it.
                           Text only: an inline field cannot honour a select's
                           options or a slider's range, and a free prompt does
                           not need it to — the whole sentence is editable in
                           the box above. */
                        onClick={() => toggleToken(name)}
                        onDoubleClick={() => {
                          if (seg.variable!.type && seg.variable!.type !== "text") return;
                          /* What you edit is the value, so the slot is put into
                             value form as it opens — otherwise you type a word
                             and the sentence closes back over it showing the
                             name, and you never see what you wrote. */
                          setTokenOverrides(o => ({ ...o, [name]: true }));
                          setEditingVar(key);
                        }}
                        title={
                          shownAsValue(name)
                            ? `${seg.variable.label || name} — click for the slot, double-click to edit`
                            : `${seg.variable.label || name} — click for the value, double-click to edit`
                        }
                      >
                        {/* The artist's name for the part, not the stored slug. The
                            slug is a database identity (lowercased, underscored,
                            sometimes v_-prefixed to satisfy the name CHECK) and
                            saying "[v_2nd_subject]" to a reader tells them
                            nothing the artist meant. */}
                        {shownAsValue(name) && value ? value : `[${seg.variable.label || name}]`}
                      </button>
                    );
                  })}
                </p>
              ) : (
                <>
                  <div style={{ position: "relative" }}>
                    <textarea
                      ref={editTaRef}
                      className="pgv-prompt-edit"
                      value={editedPrompt}
                      onChange={e => setEditedPrompt(e.target.value)}
                      onMouseUp={scheduleEditPill}
                      onKeyUp={(e) => { if (e.shiftKey || e.key === "Shift") scheduleEditPill({}); }}
                      rows={5}
                      spellCheck={false}
                      aria-label="Your version of this prompt"
                    />
                    {editPill && (
                      <button type="button" className="pgv-sel-pill" style={{ left: editPill.x, top: editPill.y }}
                        onMouseDown={(e) => e.preventDefault() /* keep the selection */}
                        onClick={addVariableFromEditSel}>+ Variable</button>
                    )}
                  </div>
                  {localTokens.length > 0 && (
                    <div className="pgv-localvars">
                      {localTokens.map((name) => (
                        <label key={name} className="pgv-localvar">
                          <span className="mono">[{name}]</span>
                          <input value={vars[name] || ""} placeholder={name}
                            onChange={(e) => onVarChange(name, e.target.value)} />
                        </label>
                      ))}
                    </div>
                  )}
                  {/* Only offered once there is something to undo, and it says
                      what it restores rather than just "reset". */}
                  <button type="button" className="pgv-prompt-revert" onClick={() => setEditedPrompt(null)}>
                    Back to the artist&apos;s wording
                  </button>
                </>
              )}
            </div>
          )}

          {/* No list of "parts" here any more (Kev, 2026-08-19).
              For a FREE prompt the text box above already IS the editor — the
              slots are clickable and editable in the sentence, so a second
              list underneath was the same value in two places. For a PAID
              prompt the type-aware inputs below are the list: they show what
              each variable is and let it be changed directly, which is what a
              buyer actually needs. */}
          {/* Variable inputs — type-aware, one block per variable.
              Skipped for a free prompt: its variables are already editable
              inside the text above, and showing both would be two controls
              writing one value. */}
          {!isFree && variables.map(renderVariable)}

          {/* Style Preset, Camera / Lens and Detail Options used to sit here as
              HARDCODED demo fields — "Minimal Brutalism", "35mm", "Keep
              brutalist geometry". They rendered for every prompt, took the
              buyer's input, and were bound to nothing: generate() only reads
              `vars`, which is keyed by the prompt's real variables. So a buyer
              filled in four fields that changed nothing about their image, on
              a page they had paid on. Removed rather than wired up: what a
              prompt asks for is the artist's decision, expressed by its
              variables, not a fixed set every prompt inherits. */}

          {/* Reference Images — gone for guests along with every other
              generation control (Kev, 2026-08-24). */}
          {!guest && (
          <div className="pgv-block">
            <div className="pgv-ref-header">
              <span className="pgv-section-label" style={{ marginBottom: 0 }}>Reference Images</span>
              <span className="pgv-ref-count">{refs.length}/10</span>
            </div>
            {/* Cascading numbered card-deck, the same shape the prompt
                editor uses for the author's own reference row: one line,
                each card overlapping the one before it, the ordinal
                always readable on the exposed left strip.

                It replaces a 4-column grid. The grid wrapped to three
                rows at ten images and pushed everything below it down
                the panel, and it showed no numbers at all — which is the
                one thing that matters here, because a prompt addresses
                these images by position (`@Image3`). Hover lifts a card
                clear of the stack so its remove button stays reachable
                from underneath. */}
            {/* dragover/drop live on the ROW, not on each card. A card only
                covers its own strip, so per-card handlers went silent over the
                opened gap and over the empty space right of the deck — exactly
                the two places the user aims at when moving an image to the
                end. The row spans all of it, and the seam comes from the
                frozen geometry, so which element reports the event no longer
                matters. */}
            <div
              className="pgv-ref-row"
              style={{ ["--pgv-ref-strip" as string]: `${refStrip}px` } as React.CSSProperties}
              onDragOver={e => {
                if (refDragI === null) return;
                // Without preventDefault the browser refuses the drop outright
                // and the card springs back with no indication why.
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const seam = seamFromX(e.clientX);
                if (seam !== null && seam !== refSeam) setRefSeam(seam);
              }}
              onDrop={e => {
                if (refDragI === null) return;
                e.preventDefault();
                const from = Number.parseInt(e.dataTransfer.getData("text/plain"), 10);
                const seam = seamFromX(e.clientX);
                // The seam counts positions in the deck WITH the carried card
                // still in it. Removing that card shifts every later position
                // down by one, so a seam to its right loses one to land where
                // the gap was drawn.
                if (!Number.isNaN(from) && seam !== null) {
                  moveRef(from, seam > from ? seam - 1 : seam);
                }
                endRefDrag();
              }}
            >
              <button
                type="button"
                className="pgv-ref-add"
                onClick={() => fileRef.current?.click()}
                disabled={refs.length >= 10}
                aria-label="Add reference images"
                title="Add reference images"
              >
                +
              </button>
              {refs.length === 0 ? (
                <span className="pgv-ref-hint">Add images this prompt can refer to</span>
              ) : (
                <div className="pgv-ref-deck">
                  {refs.map((img, idx) => (
                    <div
                      key={idx}
                      className={
                        "pgv-ref-slot" +
                        (refDragI === idx ? " dragging" : "") +
                        (refGapAt === idx ? " gap-before" : "")
                      }
                      aria-label={`Reference image ${idx + 1}`}
                      draggable
                      onDragStart={e => {
                        // Freeze the layout before anything moves; every seam
                        // for the rest of this drag is measured against it.
                        captureRefGeometry(e.currentTarget.parentElement);
                        setRefDragI(idx);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", String(idx));
                      }}
                      onDragEnd={endRefDrag}
                    >
                      {/* Click zooms, and the zoom pages through the whole
                          deck. Drag still reorders — a drag never fires the
                          click, so the two gestures do not collide. */}
                      <img
                        src={img}
                        alt={`Reference ${idx + 1}`}
                        draggable={false}
                        onClick={() => openLightbox(refs, idx)}
                        style={{ cursor: "zoom-in" }}
                      />
                      <span className="pgv-ref-num" aria-hidden="true">{idx + 1}</span>
                      <button
                        type="button"
                        className="pgv-ref-remove"
                        aria-label={`Remove reference image ${idx + 1}`}
                        onClick={() => removeRef(idx)}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                  {/* The seam past the last card needs its own element: the
                      last card may itself be the one being carried, and that
                      card's margins are already spoken for. */}
                  {refGapAt === refs.length && (
                    <span className="pgv-ref-gap-end" aria-hidden="true" />
                  )}
                </div>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={onRefUpload} />
          </div>
          )}

          {/* Generator FIRST — the model decides what the settings below
              can offer, so it reads top-down: pick the generator, then its
              settings, then (for gpt models) quality on its own comfortable
              row instead of squeezing three controls into one line
              (Kev, 2026-08-22). Hidden for guests with the rest of the
              generation controls (Kev, 2026-08-24). */}
          {!guest && (<>
          <div className="pgv-block">
            <span className="pgv-section-label">Generator</span>
            <select className="pgv-generator-select" value={generator} onChange={e => setGenerator(e.target.value)}>
              {GENERATORS.map(g => <option key={g}>{g}</option>)}
            </select>
          </div>

          <div className="pgv-block">
            <span className="pgv-section-label">Image Settings</span>
            {/* Icon instead of a stacked caps label, the way quick create
                labels its controls. "ASPECT RATIO" and "RESOLUTION" cost a
                whole line each and half the field's width in a 230px rail,
                to name two things the values already say: nobody reads
                "16:9" and wonders what it is. The word survives as the
                title/aria-label for anyone who does. */}
            <div className="pgv-img-settings">
              {/* Bare: RatioSelect draws its own frame — the .pgv-field box
                  around it read as a dropdown inside a dropdown (Kev,
                  2026-08-22). */}
              <div className="pgv-field pgv-field--bare">
                <RatioSelect value={aspect} options={aspects} onChange={setAspect} title="Aspect ratio" />
              </div>
              <div className="pgv-field">
                <Maximize2 size={12} aria-hidden />
                <select
                  value={resolution}
                  onChange={e => setResolution(e.target.value)}
                  title={noCharge
                    ? "Resolution — this run renders on the FREE route (Flux), which tops out at 2K. Paid models unlock 4K."
                    : "Resolution"}
                  aria-label="Resolution"
                >
                  {core.tiers.map(t => <option key={t.tier} value={t.tier}>{t.tier}{!noCharge && t.price != null ? ` · $${t.price.toFixed(2)}` : ""}</option>)}
                </select>
              </div>
            </div>
            {/* Quality on its own row below — room to breathe instead of a
                third control jammed into the settings line. */}
            {/* Same bare wrapper as ratio: QualitySelect now draws the same
                trigger + floating panel as RatioSelect (Kev, 2026-08-24:
                "i want the format of e.g. ratio"). */}
            {core.supportsQuality && (
              <div className="pgv-field pgv-field--bare pgv-field--quality pgv-field--row2">
                <QualitySelect value={quality} onChange={setQuality} available disabled={generating} />
              </div>
            )}
          </div>
          </>)}
        </div>

        {/* ── Sticky footer: Generate button ── */}
        {/* Both settings sit BEFORE Generate. They change what Generate will
            do, so reaching them after passing the button reads backwards, and
            the dice in particular was easy to mistake for a post-generation
            action out on the right. */}
        <div className="pgv-sidebar-footer" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Boost buys a FASTER PAID HOST for the same model. On a free
              generation there is no paid host to buy — the free branch does
              not even send the flag — so offering it promised a speed-up that
              could not happen, on a button labelled "Generate free" (Kev,
              2026-08-19). A control that changes nothing is the lie this
              codebase keeps relearning. */}
          {!guest && !noCharge && <BoostToggle boost={boost} onChange={setBoost} available={core.boostAvailable} disabled={generating} />}
          {/* publicPromptText is the only prompt text this surface may hold
              for a paid prompt; sliced because the route's zod max REJECTS an
              over-long context rather than clipping it. */}
          {!guest && (
            <DiceButton
              variables={diceVariables}
              promptId={promptId}
              context={promptText ? promptText.slice(0, DICE_LIMITS.maxContextLen) : undefined}
              onValues={applyDiceValues}
              headers={sessionAuthHeaders()}
              disabled={generating}
              title="Roll the dice — fill the fields you left empty"
            />
          )}
          {/* The label is the QUOTE total — the server's arithmetic, model
              cost and fees included. boostedCost(price) was the artist price
              alone and understated every paid generation. A paid prompt with
              no quote yet cannot promise a number, so it cannot be clicked. */}
          {freeQuota && (
            <div className="pgv-quota-note" role="status">
              {freeQuota.signIn ? (
                <>
                  <strong>Sign in to generate for free.</strong>{" "}
                  A free generation belongs to an account — without one there is nothing to count it against.
                </>
              ) : (
                <>
                  <strong>{freeQuota.used}/{freeQuota.limit} free generations used.</strong>{" "}
                  {noCharge
                    ? "This prompt only runs on the free generator, so there is nothing left to spend here."
                    : "Pick a paid generator below to keep going."}
                </>
              )}
            </div>
          )}
          <div className="pgv-generate-wrap">
            {/* Greyed for guests: they cannot pay for a generation, and a
                button that pretends otherwise is a lie (Kev, 2026-08-24). */}
            <button
              className="pgv-generate-btn"
              onClick={generate}
              disabled={generating || guest || (!noCharge && !paidQuote)}
              title={guest ? "Sign in to generate" : undefined}
            >
              {generating ? <Loader2 size={14} className="pgv-spinner" /> : <Sparkles size={14} />}
              {/* A guest sees WHY the button is dead, not a "Generate …"
                  that promises a quote which will never come (Kev,
                  2026-08-24). */}
              {guest
                ? "Log in to generate"
                : noCharge
                  ? "Generate free"
                  : paidQuote
                    ? `Generate $${paidQuote.totalUsd}`
                    : "Generate …"}
            </button>
            {/* ToS §4 requires the network fee to be itemised before the buyer
                confirms. It used to occupy its own line above the footer,
                which in a 230px rail is a lot of permanent space for a number
                that only matters once. As a marker on the button it is still
                there, still before the click, and reachable by hover, focus
                and touch — but it stops competing with the price it qualifies.
                Rendered only when the quote actually carries a fee. */}
            {!noCharge && paidQuote && (
              <span
                className="pgv-fee-info"
                tabIndex={0}
                role="note"
                aria-label={`Total includes a $${paidQuote.networkFeeUsd} network fee`}
              >
                <Info size={11} aria-hidden />
                <span className="pgv-fee-tip">
                  incl. ${paidQuote.networkFeeUsd} network fee
                  {paidQuote.appliedRule ? ` · ${paidQuote.appliedRule.name}` : ""}
                </span>
              </span>
            )}
          </div>
        </div>
        {/* x402 for AGENTS, as its own field BELOW the whole generate and
            dice element (Kev, 2026-08-23). The copy reads like a friend
            explaining it: conversational, tenth grade, no dashes. */}
        <div className={"pgv-x402" + (agentOpen ? " open" : "")}>
          <button type="button" className="pgv-x402-head" aria-expanded={agentOpen}
            onClick={() => setAgentOpen((o) => !o)}>
            &#129302; Let your AI agent use this prompt
            <ChevronDown size={13} className="pgv-x402-chev" aria-hidden />
          </button>
          {/* grid-rows 0fr -> 1fr animates BOTH directions — native details
              snaps shut, which is why this is a controlled box now
              (Kev, 2026-08-23: "fixes aufklappen und zuklappen"). */}
          <div className="pgv-x402-clip">
          {/* The middle layer carries NO padding: the body's padding does not
              collapse inside a 0fr row, which let the first lines peek out of
              a "closed" field (Kev, 2026-08-23, screenshot). */}
          <div className="pgv-x402-inner">
          <div className="pgv-x402-body">
            <p>
              Hand this prompt to your AI agent. It pays the same price as
              you, in USDC on Solana, and needs no account and no gas. The
              server tells it the exact price, it pays, it gets the image.
              Paste the request below into your agent chat.
            </p>
            <code className="pgv-x402-endpoint mono">POST {typeof window !== "undefined" ? window.location.origin : ""}/api/x402/generate</code>
            {/* Copy is the icon alone in the code box's top right corner
                (Kev, 2026-08-24) — a labelled button under the box said what
                the box already is. The toast still confirms the copy. */}
            <div className="pgv-x402-code">
              <pre className="pgv-x402-example mono">{JSON.stringify(
                promptId
                  ? { promptId, modelFamily, resolution, aspectRatio: aspect, ...(core.supportsQuality ? { quality } : {}) }
                  : { prompt: "your prompt text", modelFamily, resolution, aspectRatio: aspect },
                null, 2)}</pre>
              <button type="button" className={"pgv-x402-copy" + (agentCopied ? " copied" : "")}
                aria-label="Copy agent request" title="Copy agent request" onClick={() => {
                  const body = promptId
                    ? { promptId, modelFamily, resolution, aspectRatio: aspect, ...(core.supportsQuality ? { quality } : {}) }
                    : { prompt: "your prompt text", modelFamily, resolution, aspectRatio: aspect };
                  navigator.clipboard.writeText(
                    `curl -X POST ${window.location.origin}/api/x402/generate -H "Content-Type: application/json" -d '${JSON.stringify(body)}'`
                  ).then(() => {
                    setAgentCopied(true);
                    if (agentCopiedTimer.current) window.clearTimeout(agentCopiedTimer.current);
                    agentCopiedTimer.current = window.setTimeout(() => setAgentCopied(false), 2000);
                  }).catch(() => {});
                }}>
                {agentCopied ? <><Check size={13} /> copied!</> : <Copy size={13} />}
              </button>
            </div>
            <span className="pgv-x402-note">Solana now, EVM and Base later. Prices are final and payments are live.</span>
          </div>
          </div>
          </div>
        </div>
      </aside>

      {/* ═══ CENTER ═══ */}
      <main className="pgv-center">
        {/* Main image */}
        <div className="pgv-main-image">
          {generating && (
            <div className="pgv-overlay-generating">
              <Loader2 size={36} className="pgv-spinner" />
              <span>Generating…</span>
            </div>
          )}
          {displayImage
            ? <img src={displayImage} alt={title} onClick={() => {
                /* The MAIN image opens with the whole history as its
                   collection — a lone [displayImage] meant one-image
                   lightboxes, and arrows, thumb strip and count only render
                   for collections above one image, so the fullscreen chrome
                   never appeared from here (Kev, 2026-08-22: "warum ist das
                   nicht sichtbar"). */
                /* Everything this prompt has to show, deduped: the current
                   image, its showcase set, the generation history. A fresh
                   page has an empty history, and a one-image collection
                   renders no arrows, no strip, no count — which read as "no
                   hover responsiveness whatsoever" (Kev, 2026-08-22). */
                const coll = [...new Set([displayImage, ...allImages.map((im) => im.url), ...history])].filter(Boolean);
                openLightbox(coll, Math.max(0, coll.indexOf(displayImage)));
              }} style={{ cursor: "pointer" }} />
            : <ImageIcon size={56} color="#333" />
          }
          {/* Action buttons — appear on hover when result is ready */}
          {resultUrl && !generating && (
            <div className="pgv-image-actions">
              <button
                className={`pgv-img-action-btn ${savedToGallery ? "saved" : ""}`}
                onClick={() => {
                  if (!savedToGallery) {
                    if (userKey) {
                      addCreation(userKey, { id: `gen-${Date.now()}`, imageUrl: resultUrl, prompt: title, createdAt: new Date().toISOString() });
                      window.dispatchEvent(new Event("gallery-refresh"));
                    }
                    setSavedToGallery(true);
                    toast({ title: "Saved to Gallery" });
                  }
                }}
              >
                {savedToGallery ? <Check size={13} /> : <Bookmark size={13} />}
                {savedToGallery ? "Saved" : "Save to Gallery"}
              </button>
              <button
                className="pgv-img-action-btn"
                onClick={download}
              >
                <Download size={13} />
                Download
              </button>
            </div>
          )}
        </div>

        {/* The size that came back, next to the picture it describes.
            Stated because the free worker clamps on total pixels, so what a
            reader asked for and what they hold are routinely different — and
            until now the app showed only the request. When the two disagree
            the ask is named too, so the number reads as an explanation rather
            than as a complaint. */}
        {resultSize && (
          <div className="pgv-size-note">
            {resultSize.w} x {resultSize.h}
            {resultSize.w * resultSize.h < 1_000_000
              ? ` (${(resultSize.w * resultSize.h / 1_000_000).toFixed(2)} MP)`
              : ` (${(resultSize.w * resultSize.h / 1_000_000).toFixed(1)} MP)`}
            {noCharge && <span className="pgv-size-asked"> · {resultSize.asked} requested, the free generator caps below it</span>}
          </div>
        )}

        {/* Thumbnail strip with arrows */}
        <div className="pgv-thumb-row">
          <button
            className="pgv-thumb-arrow"
            onClick={() => setThumbOffset(o => Math.max(0, o - 1))}
            disabled={thumbOffset === 0}
          >
            <ChevronDown size={14} style={{ transform: "rotate(90deg)" }} />
          </button>

          <div className="pgv-thumb-strip">
            {visibleThumbs.map((img, idx) => {
              const absIdx = thumbOffset + idx;
              return (
                <div
                  key={absIdx}
                  className={`pgv-thumb-item ${activeThumb === absIdx ? "active" : ""}`}
                  onClick={() => { setActiveThumb(absIdx); }}
                >
                  {(img.thumbnail || img.url)
                    ? <img src={img.thumbnail || img.url} alt="" />
                    : <span style={{ fontSize: 9, color: "#444" }}>v{absIdx + 1}</span>
                  }
                  {absIdx === 0 && resultUrl && (
                    <span className="pgv-thumb-status success">✓</span>
                  )}
                </div>
              );
            })}
          </div>

          <button
            className="pgv-thumb-arrow"
            onClick={() => setThumbOffset(o => Math.min(allImages.length - 1, o + 1))}
            disabled={thumbOffset + 6 >= allImages.length}
          >
            <ChevronDown size={14} style={{ transform: "rotate(-90deg)" }} />
          </button>
        </div>

        {/* Comments / Reviews tabs */}
        <div className="pgv-center-tabs">
          <button
            className={`pgv-center-tab ${activeTab === "comments" ? "active" : ""}`}
            onClick={() => setActiveTab("comments")}
          >
            <MessageSquare size={13} />
            Comments
            <span className="pgv-center-tab-sub">(Image)</span>
          </button>
          <button
            className={`pgv-center-tab ${activeTab === "reviews" ? "active" : ""}`}
            onClick={() => setActiveTab("reviews")}
          >
            <Star size={13} />
            Reviews
            <span className="pgv-center-tab-sub">(Requires Purchase)</span>
          </button>
        </div>
      </main>

      {/* ═══ RIGHT HISTORY ═══
          Below 960px this used to be `display: none` and nothing replaced it,
          so a narrow window simply lost every generated image with no way to
          reach them — the images were still in state, just unreachable. It is
          now an off-canvas panel with a handle, so the content stays available
          at any width instead of being thrown away by a breakpoint. */}
      {/* A guest has no history to show — the whole panel and its handle go
          with the other generation surfaces (Kev, 2026-08-24). */}
      {!guest && !historyOpen && (
        <button
          type="button"
          className="pgv-history-handle"
          onClick={() => setHistoryOpen(true)}
          aria-label={`Your history${history.length ? ` (${history.length})` : ""}`}
          title="Your history"
        >
          <ImageIcon size={13} aria-hidden />
          {history.length > 0 && <span className="pgv-history-handle__n">{history.length}</span>}
        </button>
      )}
      {!guest && (
      <aside className={`pgv-history${historyOpen ? " pgv-history--open" : ""}`}>
        <div className="pgv-history-header">
          <span>Your History</span>
          <button
            type="button"
            onClick={() => setHistoryOpen(false)}
            aria-label="Close history"
            title="Close history"
          >
            <X size={12} />
          </button>
        </div>
        <div className="pgv-history-list">
          {history.length === 0 && (
            <div className="pgv-history-empty">
              Generate an image<br />to see it here
            </div>
          )}
          {history.map((url, idx) => (
            <div
              key={idx}
              className="pgv-history-item"
              onClick={() => openLightbox(history, idx)}
            >
              <img src={url} alt="" />
              <span className="pgv-history-status success">✓</span>
            </div>
          ))}
        </div>
        {history.length > 5 && (
          <div className="pgv-history-scroll-hint">
            <ChevronDown size={12} />
          </div>
        )}
      </aside>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div className={"pgv-lightbox" + (lbAwake ? "" : " pgv-lb-asleep")} onClick={() => setLightbox(null)}
          onMouseMove={wakeLb} onTouchStart={wakeLb}>
          <img src={lightbox.urls[lightbox.at]} alt={`Expanded ${lightbox.at + 1} of ${lightbox.urls.length}`} />
          {/* The collection as a strip along the bottom — jump anywhere
              without paging. Chrome like everything else: asleep after 1s. */}
          {lightbox.urls.length > 1 && (
            <div className="pgv-lb-strip pgv-lb-chrome" onClick={e => e.stopPropagation()}>
              {lightbox.urls.map((u, i) => (
                <button key={u + i} type="button" className={"pgv-lb-thumb" + (i === lightbox.at ? " on" : "")}
                  onClick={() => setLightbox({ urls: lightbox.urls, at: i })} aria-label={`Image ${i + 1}`}>
                  <img src={u} alt="" draggable={false} />
                </button>
              ))}
            </div>
          )}
          {/* The generation history rides along on the right, as on the page
              — picking one switches the lightbox to browsing the history. */}
          {history.length > 0 && (
            <div className="pgv-lb-hist pgv-lb-chrome" onClick={e => e.stopPropagation()}>
              {history.map((u, i) => (
                <button key={u} type="button" className={"pgv-lb-thumb" + (lightbox.urls === history && i === lightbox.at ? " on" : "")}
                  onClick={() => setLightbox({ urls: history, at: i })} aria-label={`History ${i + 1}`}>
                  <img src={u} alt="" draggable={false} />
                </button>
              ))}
            </div>
          )}
          <button className="pgv-lightbox-close pgv-lb-chrome" onClick={() => setLightbox(null)} aria-label="Close">
            <X size={18} />
          </button>
          {lightbox.urls.length > 1 && (
            <>
              {/* Edge arrows, stopPropagation so the backdrop's close does not
                  swallow the click. The same step the arrow keys take. */}
              <button
                type="button"
                className="pgv-lightbox-nav pgv-lightbox-nav--prev pgv-lb-chrome"
                onClick={e => { e.stopPropagation(); stepLightbox(-1); }}
                aria-label="Previous image"
              >
                <ChevronLeft size={26} />
              </button>
              <button
                type="button"
                className="pgv-lightbox-nav pgv-lightbox-nav--next pgv-lb-chrome"
                onClick={e => { e.stopPropagation(); stepLightbox(1); }}
                aria-label="Next image"
              >
                <ChevronRight size={26} />
              </button>
              <span className="pgv-lightbox-count pgv-lb-chrome" aria-live="polite">
                {lightbox.at + 1} / {lightbox.urls.length}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
