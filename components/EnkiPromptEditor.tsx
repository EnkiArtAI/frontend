"use client";

import { Fragment, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PAYMENT_CHAINS } from "@/shared/payment-config";
import { addCreation, getUserKeyFromAccount } from "@/lib/creations";
import { usePaymentSigner } from "@/hooks/usePaymentSigner";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useCdpSolanaSigner } from "@/hooks/useCdpSolanaSigner";
import { useModelLimits, useModelCatalogue, FALLBACK_RATIOS, resolveCatalogueEntry } from "@/hooks/useModelLimits";
import { runGeneration } from "@/lib/generation/run-generation";
import { useServerQuotes, quoteLabel } from "@/hooks/useServerQuotes";
import { tiersUpTo } from "@/lib/generation/resolution";
import BoostToggle from "@/components/generation/BoostToggle";
import QualitySelect, { type Quality } from "@/components/generation/QualitySelect";
import EnkiMobileGenerateModal from "./EnkiMobileGenerateModal";
import { WalletPickerModal } from "./WalletPickerModal";
import {
  Settings,
  Plus,
  Sparkles,
  AlertTriangle,
  Zap,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Type,
  Tags,
  Cpu,
  Ratio,
  ImageIcon,
  DollarSign,
  Trash2,
  X,
  Check,
  Undo2,
  Redo2,
  Eraser,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ENKI_CATEGORIES } from "@/components/enki/EnkiFilters";
import { sessionAuthHeaders } from "@/lib/session-headers";
import {
  loadEditorVersions,
  saveEditorVersions,
  clearEditorVersions,
  type PersistedVersionCard,
} from "@/lib/editorVersions";
import nlp from "compromise";
import { getVariableColors, pickVariableColorIndex } from "@/lib/variableColors";
import DiceButton from "@/components/DiceButton";
import { DICE_LIMITS, type DiceValue, type DiceVariable } from "@/lib/generation/variable-dice";


const EDITOR_DRAFT_KEY = "symphora-editor-draft-v1";
const OWNERSHIP_NOTICE_DISMISS_KEY = "symphora-ownership-notice-dismissed-v1";

// Horizontal padding (px) inside the prompt textarea / overlay box.
// MUST equal `--enk-prompt-pad-x` in `app/editor/enki-editor.css`.
// Used by `syncPromptOverlayMetrics` to compute the overlay's right
// padding so its text wraps at the same column as the textarea.
const PROMPT_PAD_X = 18;

/**
 * True iff the prompt textarea contains real, user-typed content.
 * Empty string, pure whitespace, and `[brackets]`-only bodies all return
 * false so the "Push prompt to Verify" arrow can be greyed out and
 * blocked correctly.
 */
function hasSubstantivePromptBody(body: string): boolean {
  return body.replace(/\[[^\]]*\]/g, "").trim().length > 0;
}

/**
 * Inline-tag pattern recognised inside the prompt body. Two forms
 * are supported:
 *   - `[varName]`         → user-defined variables (variable column)
 *   - `@Image{N}`         → reference-image mentions (Settings list)
 *
 * Both are split out by the overlay renderer so they can be styled
 * as colored / grey chips while remaining character-aligned with
 * the underlying textarea text. The capturing group keeps the
 * delimiters in the result so we can re-classify each part.
 */
const PROMPT_INLINE_TOKEN_RE = /(\[[^\]]*\]|@Image\d+)/g;
const REF_IMAGE_MENTION_RE = /^@Image(\d+)$/;
const REF_IMAGE_MENTION_GLOBAL_RE = /@Image(\d+)/g;

/**
 * Replaces every `@ImageN` inline token in the prompt body with the
 * canonical "Reference image N" wording before the body crosses any
 * boundary the user can't undo from (DB save, generate request).
 *
 * The `@ImageN` form is purely an in-editor convenience — it lets
 * the prompt author point at one of the stored reference images
 * without polluting the variables column. By the time the body is
 * persisted or sent to an AI provider it must read like normal
 * prose, so we expand it server-bound.
 */
function expandReferenceImageMentions(body: string): string {
  return body.replace(REF_IMAGE_MENTION_GLOBAL_RE, "Reference image $1");
}

/**
 * Walks backwards from `caret` looking for an active `@`-mention
 * being typed. Returns null unless the caret is sitting inside a
 * fresh `@…` token (no whitespace, no `[`/`]`, no second `@`)
 * whose `@` is at the start of the body or directly after
 * whitespace. Used to drive the reference-image dropdown.
 */
function detectMentionAtCaret(
  body: string,
  caret: number
): { startPos: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = body[i];
    if (ch === "@") {
      const prev = i === 0 ? null : body[i - 1];
      if (prev === null || /\s/.test(prev)) {
        const query = body.substring(i + 1, caret);
        if (!/[\s@\[\]]/.test(query)) {
          return { startPos: i, query };
        }
      }
      return null;
    }
    if (/[\s\[\]]/.test(ch)) return null;
    i--;
  }
  return null;
}

/**
 * Returns the viewport-relative pixel coordinates of the character
 * at `position` inside `textarea`. Uses the well-known "mirror div"
 * technique: render an off-screen `<div>` that copies every text-
 * affecting computed style of the textarea, drop the substring
 * up to `position` into it, mark `position` with a 1-char `<span>`,
 * and read back the span's offset.
 *
 * The mirror only needs to be on-screen for one synchronous read,
 * so we append/remove it inside the same call. textarea.scrollTop /
 * scrollLeft are subtracted so the result tracks the visible caret
 * even when the textarea has been scrolled internally.
 *
 * Used by the @-mention dropdown to anchor itself directly under
 * the `@` glyph instead of the textarea's bottom edge.
 */
function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number
): { top: number; left: number; height: number } {
  const computed = window.getComputedStyle(textarea);
  const div = document.createElement("div");
  const style = div.style;

  /* Properties that influence text wrapping/measurement and must
     match the source textarea exactly for the mirror to render
     identical line breaks. Any deviation (e.g. font-size, padding,
     letter-spacing) puts the caret in the wrong place. */
  const propsToCopy: ReadonlyArray<string> = [
    "direction", "boxSizing", "width", "height",
    "overflowX", "overflowY",
    "borderTopWidth", "borderRightWidth",
    "borderBottomWidth", "borderLeftWidth",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "fontStyle", "fontVariant", "fontWeight", "fontStretch",
    "fontSize", "fontSizeAdjust", "lineHeight", "fontFamily",
    "textAlign", "textTransform", "textIndent",
    "letterSpacing", "wordSpacing", "tabSize",
    "whiteSpace", "wordBreak", "wordWrap",
  ];

  style.position = "absolute";
  style.visibility = "hidden";
  style.top = "0";
  style.left = "0";
  style.whiteSpace = "pre-wrap";
  style.wordWrap = "break-word";
  style.overflow = "hidden";

  const styleRec = style as unknown as Record<string, string>;
  const computedRec = computed as unknown as Record<string, string>;
  for (const prop of propsToCopy) {
    const v = computedRec[prop];
    if (typeof v === "string") styleRec[prop] = v;
  }

  div.textContent = textarea.value.substring(0, position);

  /* Single-char span at the position. We use a non-empty marker
     (".") if `position` sits at end-of-input; otherwise the span
     would have zero height and offsetTop would lie. */
  const span = document.createElement("span");
  span.textContent = textarea.value.substring(position) || ".";
  div.appendChild(span);

  document.body.appendChild(div);
  const spanTop = span.offsetTop;
  const spanLeft = span.offsetLeft;
  const lineHeight =
    parseFloat(computed.lineHeight) ||
    parseFloat(computed.fontSize) * 1.2 ||
    20;
  document.body.removeChild(div);

  const taRect = textarea.getBoundingClientRect();
  return {
    top: taRect.top + spanTop - textarea.scrollTop,
    left: taRect.left + spanLeft - textarea.scrollLeft,
    height: lineHeight,
  };
}

/* ─── Types ─── */
type VariableType = "text" | "checkbox" | "image";
type PromptType = "free-prompt" | "premium-prompt";
type SettingsSectionId = "title" | "category" | "models" | "ratio" | "references" | "price";

interface EditorDraft {
  promptData: { title: string; body: string; type: PromptType; tags: string[] };
  variables: PromptVariable[];
  modelsSelected: string[];
  ratioSelected: string;
  maxImages: number;
  referenceImages: string[];
  promptPrice: number;
  settingsCollapsed: boolean;
  savedAt: number;
  // Saved-prompt id must survive reloads: without it a Turnkey user's saved
  // prompt silently falls back to the SOL-requiring x402 flow after refresh.
  currentPromptId?: string | null;
}

// (A translation table mapping editor-only ratios to their nearest provider
// ratio used to live here. It was never referenced — nothing translated — so
// picking 4:5, 3:2 or 21:9 sent an unsupported ratio straight to the provider.
// The fix is upstream: the editor now only offers what models.allowed_ratios
// says the selected generator takes, so there is nothing left to translate.)

function buildFullToken(inner: string): string {
  return `[${inner}]`;
}

function collectVariableLabels(
  variables: PromptVariable[],
  excludeVarId?: string
): Set<string> {
  const labels = new Set<string>();
  for (const v of variables) {
    if (excludeVarId && v.id === excludeVarId) continue;
    const name = v.name?.trim();
    if (name) labels.add(name.toLowerCase());
    const inner = v.fullToken.match(/^\[([^\]]*)\]$/)?.[1]?.trim();
    if (inner) labels.add(inner.toLowerCase());
  }
  return labels;
}

function buildLabelRegistry(
  variables: PromptVariable[],
  body: string,
  excludeVarId?: string
): Set<string> {
  const labels = collectVariableLabels(variables, excludeVarId);
  const regex = /\[([^\]]*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const inner = match[1].trim();
    if (inner) labels.add(inner.toLowerCase());
  }
  return labels;
}

/** Mutates `labels` and reserves the chosen label (safe for rapid successive calls). */
function allocateUniqueVariableLabel(labels: Set<string>, base: string): string {
  const seed = base.trim() || "Variable";
  const seedKey = seed.toLowerCase();
  if (!labels.has(seedKey)) {
    labels.add(seedKey);
    return seed;
  }
  let n = 2;
  let candidate = `${seed}${n}`;
  while (labels.has(candidate.toLowerCase())) {
    n += 1;
    candidate = `${seed}${n}`;
  }
  labels.add(candidate.toLowerCase());
  return candidate;
}

function takeUniqueVariableLabel(
  registryRef: { current: Set<string> },
  base: string,
  variables: PromptVariable[],
  body: string,
  excludeVarId?: string
): string {
  const labels = buildLabelRegistry(variables, body, excludeVarId);
  registryRef.current.forEach((label) => labels.add(label));
  const result = allocateUniqueVariableLabel(labels, base);
  registryRef.current = labels;
  return result;
}

function findVariableByName(
  name: string,
  variables: PromptVariable[],
  excludeVarId: string
): PromptVariable | undefined {
  const lower = name.trim().toLowerCase();
  if (!lower) return undefined;
  return variables.find(
    (v) =>
      v.id !== excludeVarId &&
      Boolean(v.name?.trim()) &&
      v.name.trim().toLowerCase() === lower
  );
}

/** Resolved inner text for [brackets] when not editing (never empty if default exists) */
function getTokenInner(
  variable: PromptVariable,
  editingNameVarId: string | null
): string {
  if (editingNameVarId === variable.id) {
    return variable.name ?? "";
  }
  const named = variable.name?.trim();
  if (named) return named;
  if (variable.type === "checkbox") {
    return variable.defaultValue
      ? String(variable.description || variable.label || "")
      : "";
  }
  return String(variable.defaultValue ?? variable.label ?? "");
}

/** Prompt body token — empty name never becomes []; keeps default in editor */
function getPromptTokenInner(
  variable: PromptVariable,
  editingNameVarId: string | null
): string {
  if (editingNameVarId === variable.id) {
    const named = variable.name?.trim();
    if (named) return named;
  }
  return getTokenInner(variable, null);
}

function replaceTokenInBody(body: string, oldToken: string, newToken: string): string {
  if (!oldToken || oldToken === newToken) return body;
  return body.split(oldToken).join(newToken);
}

function getVariableReplacementText(variable: PromptVariable): string {
  if (variable.type === "checkbox") {
    return String(variable.defaultValue ? variable.description : "");
  }
  return String(variable.defaultValue ?? variable.label ?? "");
}

function getVariableDeleteLabel(variable: PromptVariable): string {
  const named = variable.name?.trim();
  if (named) return `[${named}]`;
  return variable.fullToken;
}

function formatVerifySnapshotValue(
  val: string,
  variable?: PromptVariable
): string {
  if (!variable) return val?.trim() || "—";
  if (variable.type === "checkbox") {
    const on = val === "on" || val === "true";
    return on ? variable.description || "Yes" : "Off";
  }
  return val?.trim() || "—";
}

function normalizeVariable(v: PromptVariable, colorContext: PromptVariable[] = []): PromptVariable {
  let next: PromptVariable =
    v.type !== "image"
      ? v
      : {
          ...v,
          type: "text",
          defaultValue:
            v.description ||
            (typeof v.defaultValue === "string" && !v.defaultValue.startsWith("data:")
              ? v.defaultValue
              : v.label),
        };
  if (next.colorIndex === undefined) {
    next = { ...next, colorIndex: pickVariableColorIndex(colorContext) };
  }
  return next;
}

interface PromptVariable {
  id: string;
  name: string;
  label: string;
  description: string;
  type: VariableType;
  defaultValue: string | boolean;
  values: string[]; // stack of multiple values for batch generation
  required: boolean;
  position: number;
  fullToken: string; // The literal string in the prompt (e.g. "[red car]")
  colorIndex?: number;
  nameBlurEmpty?: boolean;
  /* True iff the user tried to "Push to Verify" while this variable
     had an empty/whitespace name AND then dismissed the alert. The
     flag draws a red border around the variable card and its
     in-prompt tag until the user actually types a name. Cleared
     automatically the moment `name.trim()` becomes non-empty. */
  nameMissingHighlighted?: boolean;
}

interface VersionCard {
  id: number;
  variableSnapshot: Record<string, string>;
  imageUrl: string | null;
  /** Durable source URL (a hosted https URL or a base64 `data:` URL).
      `imageUrl` may become an ephemeral `blob:` URL for display, so this
      preserves something we can persist + restore across reloads. */
  sourceUrl?: string | null;
  status: "idle" | "queued" | "generating" | "complete" | "failed";
  queuePosition?: number; // assigned when batch-queued
  /** Per-card reference images (data URLs) fed to this card's render. */
  referenceImages?: string[];
}

/* ─── Color map for known variables ─── */
function EmptyVarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <line x1="4" y1="6" x2="16" y2="6" stroke="#C4BDB5" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="4" y1="10" x2="13" y2="10" stroke="#C4BDB5" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="4" y1="14" x2="10" y2="14" stroke="#C4BDB5" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* ─── Component ─── */
/** A local id for a stored creation. Called from the generate handler, never during render. */
const creationId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export default function EnkiPromptEditor() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const account = useActiveAccount();
  const { connected: solanaAdapterConnected } = useWallet();
  const { address: cdpAddress } = useCdpAddress();
  const cdpSolana = useCdpSolanaSigner();
  // Anyone who can sign a Solana transaction counts as "Solana connected":
  // an external adapter or a CDP embedded wallet.
  const solanaConnected = solanaAdapterConnected || cdpSolana.isAvailable || !!cdpAddress;
  const signPayment = usePaymentSigner();
  // Payments run on Solana only.
  const currentNetworkName = PAYMENT_CHAINS["solana"].name;
  const { toast } = useToast();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hitOverlayRef = useRef<HTMLDivElement>(null);
  /* Wrapping box around the textarea — used as the positioning
     anchor for the @-mention dropdown. We compute the dropdown's
     fixed-position coordinates off this ref so the popup can float
     above panels with `overflow: hidden` (which would otherwise
     clip an absolutely positioned child). */
  const textareaBoxRef = useRef<HTMLDivElement>(null);
  const [mentionAnchor, setMentionAnchor] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const settingsSectionRefs = useRef<Partial<Record<SettingsSectionId, HTMLDivElement>>>({});
  const settingsHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsExpandDelayRef = useRef(0);
  const variablesScrollRef = useRef<HTMLDivElement>(null);
  const variableCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const variablePulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingVarScrollRef = useRef<string | null>(null);
  const variableLabelRegistryRef = useRef<Set<string>>(new Set());
  const [promptPrice, setPromptPrice] = useState(0);
  /* Raw text backing the price <input>. A number-only state can't hold
     intermediate values like "0" or "0." (both coerce to 0, which the
     controlled input renders as ""), so the user could never type a
     decimal that starts with a zero. We keep the raw string here and
     derive `promptPrice` from it. */
  const [priceText, setPriceText] = useState("");
  /* Direction of the most recent stepper-button press on the price
     input. Drives a brief slide-in animation on the number text so
     a tap on ▲/▼ is reflected visually (a "roll" up or down) even
     though the value change is tiny. Null when idle. */
  const [priceRollDir, setPriceRollDir] = useState<"up" | "down" | null>(null);
  const priceRollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Snapshot of the price value AT THE START of the last roll.
     Used by the visual-layer renderer to diff prev vs current and
     animate ONLY the digits that actually changed (slot-machine
     style — the user explicitly does not want the whole number to
     move). Updated synchronously inside handlePriceStep and reset
     by the timeout that ends the animation. */
  const prevPriceRollSnapshotRef = useRef<number>(0);
  const priceRollKeyRef = useRef(0);

  /* Keep the price text field in sync when the price changes from OUTSIDE
     the input (stepper buttons, draft restore, model min-price). We avoid
     clobbering while the user is mid-typing an equivalent value — e.g.
     "0." parses to 0, which already equals the stored price — so the
     leading-zero decimal stays typeable. */
  useEffect(() => {
    const typed = parseFloat(priceText);
    if (!Number.isFinite(typed) || typed !== promptPrice) {
      setPriceText(promptPrice ? String(promptPrice) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptPrice]);

  /* Same pair of refs for the integer Max-User-Images stepper so it
     gets identical "only the changing digit moves" behaviour. */
  const [maxImagesRollDir, setMaxImagesRollDir] = useState<"up" | "down" | null>(null);
  const maxImagesRollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevMaxImagesRollSnapshotRef = useRef<number>(10);
  const maxImagesRollKeyRef = useRef(0);

  /* ─── State: DB Models ─── */
  const { data: fetchedModels = [] } = useQuery({
    queryKey: ["/api/models"],
    queryFn: async () => {
      const res = await fetch("/api/models");
      if (!res.ok) throw new Error("Failed to fetch models");
      return res.json();
    }
  });

  /* ─── Structured State ─── */
  const [promptData, setPromptData] = useState({
    title: "",
    body: "",
    type: "free-prompt" as PromptType,
    tags: [] as string[],
  });

  const [models, setModels] = useState<{ available: any[], selected: string[] }>({
    available: [],
    selected: []
  });

  // Boost: same model on a priority host. Sent with every generation so the
  // server can pick the route; the price follows in the quote.
  const [boost, setBoost] = useState(false);
  const [quality, setQuality] = useState<Quality>("medium");
  const [ratios, setRatios] = useState<{ available: string[], selected: string }>({
    available: [],
    selected: "Any ratio"
  });

  const [variables, setVariables] = useState<PromptVariable[]>([]);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [refImageDrag, setRefImageDrag] = useState<{
    from: number | null;
    over: number | null;
  }>({ from: null, over: null });
  /* True iff the user is currently dragging one or more files from
     OUTSIDE the app (e.g. desktop) over the reference-images zone.
     Used to highlight the dashed border AND to show the live
     "Drop here as image #N" hint at the bottom of the zone. We track
     it via a counter ref because dragenter/dragleave fire many times
     as the cursor crosses child elements, and naive boolean state
     would flicker. */
  const [externalDragActive, setExternalDragActive] = useState(false);
  const externalDragCounterRef = useRef(0);
  /* Index of the reference image currently shown in the fullscreen
     lightbox. `null` = lightbox closed. Opening is triggered by a
     plain CLICK on a slot — drag-and-drop reorders are mutually
     exclusive because the browser suppresses the trailing `click`
     event when a drag has actually started. */
  const [refPreviewIndex, setRefPreviewIndex] = useState<number | null>(null);
  /* Direction of the LAST navigation, used to pick the slide-in
     keyframe so each new image enters from the correct side
     instead of fading from a corner. "init" = first open (spring
     pop), "next" = arrow right (slide from right), "prev" = arrow
     left (slide from left). */
  const [refPreviewDirection, setRefPreviewDirection] = useState<"init" | "next" | "prev">("init");
  /* Hover-tooltip ("Sprechblase") for `@Image{N}` chips inside the
     prompt body. When the user hovers a chip in the hit-overlay we
     snapshot the chip's viewport rect + the 1-based image index and
     render a portalled bubble pointing back at the chip with a
     larger preview of the actual reference image. Cleared on mouse
     leave. Anchor rect is captured at hover-time only — if the user
     scrolls while hovering, mouseleave fires anyway and the bubble
     unmounts, so we don't need a follow-the-element loop. */
  const [refTooltip, setRefTooltip] = useState<{
    imageIndex: number; // 1-based, matches `@Image{N}`
    anchor: { top: number; bottom: number; centerX: number };
  } | null>(null);
  /* Reference-image @-mention dropdown state. Triggered when the
     user types `@` directly after whitespace inside the prompt
     textarea — the dropdown lists every uploaded reference image
     and inserts an `@Image{N}` token at the caret on selection.
       open       — visible iff caret is inside a fresh @-mention
       query      — text typed AFTER the @, used to filter results
       startPos   — body offset of the leading @ (replacement anchor)
       highlighted — index into the (filtered) match list */
  const [mention, setMention] = useState<{
    open: boolean;
    query: string;
    startPos: number;
    highlighted: number;
  }>({ open: false, query: "", startPos: -1, highlighted: 0 });
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const draftReadyRef = useRef(false);
  /* Gates the verify-card autosave until the IndexedDB restore has run,
     so the initial empty `versions` array can't clobber saved cards. */
  const versionsReadyRef = useRef(false);
  /* Variable-sync (new variable → existing verify cards) bookkeeping.
     `syncedVarIds` holds the variable ids the parked verify cards already
     account for; a variable whose id isn't in here is genuinely NEW and
     triggers the "apply everywhere?" prompt. `primed` guards the very first
     run after restore so existing variables aren't all treated as new.
     `confirming` distinguishes a confirm-close from a cancel-close. */
  const syncedVarIdsRef = useRef<Set<string>>(new Set());
  const varSyncPrimedRef = useRef(false);
  const varSyncConfirmingRef = useRef(false);
  /* The freshly-added variable id(s) the prompt is currently asking about,
     so that "No" can undo the insertion entirely. */
  const pendingNewVarIdsRef = useRef<string[]>([]);

  /* ─── Undo / Redo history ─────────────────────────────────────────
     A debounced snapshot stack of the editor's structural state:
     prompt title/body/type/tags, variables, selected models, selected
     ratio and reference images — everything Ctrl+Z should roll back.
     UI-only state (selected card, dialogs) is excluded. Stacks live in
     refs (O(1) pushes, no re-render); `historyVersion` bumps to refresh
     the toolbar buttons. Tracking starts only after the draft hydrates. */
  type FocusContext =
    | { type: "textarea"; cursorPos: number }
    | { type: "varName"; varId: string; cursorPos: number }
    | { type: "varDesc"; varId: string; cursorPos: number }
    | null;
  type EditorSnapshot = {
    promptData: { title: string; body: string; type: PromptType; tags: string[] };
    variables: PromptVariable[];
    modelsSelected: string[];
    ratiosSelected: string;
    referenceImages: string[];
    focus?: FocusContext;
  };
  const HISTORY_LIMIT = 100;
  const historyPastRef = useRef<EditorSnapshot[]>([]);
  const historyFutureRef = useRef<EditorSnapshot[]>([]);
  const historySnapshotRef = useRef<EditorSnapshot | null>(null);
  const historyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isApplyingHistoryRef = useRef(false);
  const gestureFocusRef = useRef<FocusContext | undefined>(undefined);
  const [historyVersion, setHistoryVersion] = useState(0);

  const [versions, setVersions] = useState<VersionCard[]>([]);

  const [ui, setUi] = useState({
    selectedCards: [] as number[],
    cursorPos: 0,
    selectedVariableId: "lighting" as string | null,
    maxImages: 10,
    settingsCollapsed: false,
    settingsReleaseAttempted: false,
    settingsPendingSection: null as SettingsSectionId | null,
    settingsHighlightSection: null as SettingsSectionId | null,
    settingsPulseOnNavigate: true,
    pricePerRenderReviewed: false,
    variablePulsingId: null as string | null,
    variableDeleteId: null as string | null,
    variableNameConflict: null as {
      editingVarId: string;
      conflictName: string;
      existingVarId: string;
    } | null,
    currentPromptId: null as string | null,
    showAvatarDropdown: false,
    tooltip: null as { x: number, y: number, text: string } | null,
    tagInput: "",
    isGrokFilling: false,
    queueTotal: 0,
    isEditingVersion: false,
    editingVersionId: null as number | null,
    editingNameVarId: null as string | null,
    ownershipNoticeDismissed: false,
    /* Drives the "Please set up variable names first!" alert that
       blocks the forward arrow when one or more variables still
       have an empty name. Toggled by the arrow's onClick and
       cleared by the alert's OK button. */
    variableNameMissingAlertOpen: false,
    /* Holds the verify-card id whose snapshot is about to overwrite
       the current variable defaults. Non-null = the "Are you sure?"
       confirmation dialog is open. The dialog's "Yes" button reads
       this id, performs the overwrite, and clears the field. */
    editOverwriteConfirmCardId: null as number | null,
    /* Pending variable type switch awaiting confirmation. Non-null when
       the user tries to change a variable's type while verify images
       already exist (changing it resets those images). */
    pendingTypeChange: null as { varId: string; newType: VariableType } | null,
    /* Drives the "Start a new prompt?" confirmation for the New button. */
    confirmNewOpen: false,
    /* Drives the "Apply new variable to existing verify renders?" dialog —
       shown when a newly-added variable needs to be folded into verify
       cards that already have generated images. */
    pendingVarSync: false,
  });

  // Per-model reference-image cap from the models table: the user-adjustable
  // maxImages can never exceed what the selected generator supports.
  const modelLimits = useModelLimits(models.selected[0]);
  useEffect(() => {
    setUi((p) => (p.maxImages > modelLimits.maxRefs ? { ...p, maxImages: modelLimits.maxRefs } : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelLimits.maxRefs]);

  /* Controls the single-select Category dropdown so it closes on pick. */
  const [catOpen, setCatOpen] = useState(false);
  const [isMobileModalOpen, setIsMobileModalOpen] = useState(false);
  /* Drives the slide-down/fade-out animation on the ownership notice.
     Stays `true` only between the X click and the unmount (~280ms),
     after which `ui.ownershipNoticeDismissed` removes the element. */
  const [noticeLeaving, setNoticeLeaving] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const walletConnected = Boolean(account?.address) || solanaConnected;
  const isGeneratingPaymentPending = versions.some((v) => v.status === "generating" || v.status === "queued");

  useEffect(() => {
    const handleResize = () => setIsMobileViewport(window.innerWidth <= 768);
    handleResize(); // Initial check
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  /* ─── Restore local draft (survives refresh / leaving the page) ─── */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(EDITOR_DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw) as EditorDraft;
        if (draft?.promptData) {
          setPromptData(draft.promptData);
          const restored = (draft.variables || []) as PromptVariable[];
          setVariables(
            restored.map((v, i) => normalizeVariable(v, restored.slice(0, i)))
          );
          setReferenceImages(draft.referenceImages || []);
          setUi((prev) => ({
            ...prev,
            maxImages: draft.maxImages ?? prev.maxImages,
            currentPromptId: draft.currentPromptId ?? null,
          }));
          if (draft.modelsSelected?.length) {
            // One model runs and is saved; older drafts may still hold several.
            setModels((prev) => ({ ...prev, selected: draft.modelsSelected.slice(0, 1) }));
          }
          if (draft.ratioSelected) {
            setRatios((prev) => ({ ...prev, selected: draft.ratioSelected }));
          }
          setDraftSavedAt(draft.savedAt ?? null);
          if (typeof draft.promptPrice === "number") setPromptPrice(draft.promptPrice);
          if (typeof draft.settingsCollapsed === "boolean") {
            setUi((prev) => ({ ...prev, settingsCollapsed: draft.settingsCollapsed }));
          }
          toast({
            title: "Draft restored",
            description: "Your last editor session was loaded from this browser.",
          });
        }
      }
    } catch {
      /* ignore corrupt draft */
    } finally {
      draftReadyRef.current = true;
    }
  }, [toast]);

  /* Restore the "ownership notice dismissed" flag from localStorage so
     the warning stays hidden after the user closes it once. */
  useEffect(() => {
    try {
      if (localStorage.getItem(OWNERSHIP_NOTICE_DISMISS_KEY) === "1") {
        setUi((p) => ({ ...p, ownershipNoticeDismissed: true }));
      }
    } catch {
      /* ignore storage errors */
    }
  }, []);

  const dismissOwnershipNotice = useCallback(() => {
    try {
      localStorage.setItem(OWNERSHIP_NOTICE_DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setUi((p) => ({ ...p, ownershipNoticeDismissed: true }));
  }, []);

  /* ─── Autosave draft to localStorage ─── */
  useEffect(() => {
    if (!draftReadyRef.current) return;
    const timeoutId = setTimeout(() => {
      try {
        const draft: EditorDraft = {
          promptData,
          variables: variables.map((v) => normalizeVariable(v)),
          modelsSelected: models.selected,
          ratioSelected: ratios.selected,
          maxImages: ui.maxImages,
          referenceImages,
          promptPrice,
          settingsCollapsed: ui.settingsCollapsed,
          savedAt: Date.now(),
          currentPromptId: ui.currentPromptId,
        };
        localStorage.setItem(EDITOR_DRAFT_KEY, JSON.stringify(draft));
        setDraftSavedAt(draft.savedAt);
      } catch {
        /* quota exceeded — skip silently */
      }
    }, 400);
    return () => clearTimeout(timeoutId);
  }, [promptData, variables, models.selected, ratios.selected, ui.maxImages, ui.settingsCollapsed, referenceImages, promptPrice, ui.currentPromptId]);

  /* ─── Restore parked verify cards (images + variable values + per-card
     reference images) from IndexedDB so the session survives a reload ─── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await loadEditorVersions();
        if (cancelled) return;
        if (saved.length) {
          const restored: VersionCard[] = saved.map((v) => {
            // Anything mid-flight (queued/generating) or failed comes back
            // as idle so the user can simply re-generate it.
            const baseStatus = v.status === "complete" ? "complete" : "idle";
            // `blob:` URLs die on reload — fall back to the durable source.
            const durable =
              v.imageUrl && !v.imageUrl.startsWith("blob:")
                ? v.imageUrl
                : v.sourceUrl ?? null;
            const status: VersionCard["status"] =
              baseStatus === "complete" && !durable ? "idle" : baseStatus;
            return {
              id: v.id,
              variableSnapshot: v.variableSnapshot || {},
              imageUrl: status === "complete" ? durable : null,
              sourceUrl: durable,
              status,
              referenceImages: v.referenceImages,
            };
          });
          setVersions(restored);
        }
      } catch {
        /* ignore — start with an empty verify column */
      } finally {
        versionsReadyRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ─── Autosave verify cards to IndexedDB ─── */
  useEffect(() => {
    if (!versionsReadyRef.current) return;
    const timeoutId = setTimeout(() => {
      const payload: PersistedVersionCard[] = versions.map((v) => {
        const baseStatus =
          v.status === "complete" || v.status === "failed" ? v.status : "idle";
        const durable =
          v.sourceUrl && !v.sourceUrl.startsWith("blob:")
            ? v.sourceUrl
            : v.imageUrl && !v.imageUrl.startsWith("blob:")
            ? v.imageUrl
            : null;
        const status: PersistedVersionCard["status"] =
          baseStatus === "complete" && !durable ? "idle" : baseStatus;
        return {
          id: v.id,
          variableSnapshot: v.variableSnapshot,
          imageUrl: status === "complete" ? durable : null,
          sourceUrl: durable,
          status,
          referenceImages: v.referenceImages,
        };
      });
      void saveEditorVersions(payload);
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [versions]);

  /* Fold every currently-named variable into each verify card's frozen
     snapshot (so a newly-added variable also applies to existing renders).
     When `reset` is true, parked images are cleared back to idle so they
     re-generate with the new variable set. */
  const applyVarSyncToVersions = useCallback(
    (reset: boolean) => {
      const named = variables.filter((v) => v.name.trim());
      const snapValue = (v: PromptVariable): string => {
        if (v.type === "checkbox") return v.defaultValue ? v.description || "on" : "off";
        if (v.type === "image") return v.description || "";
        return (v.defaultValue as string) || v.name;
      };
      setVersions((prev) => {
        let touched = false;
        const next = prev.map((card) => {
          const snapshot = { ...card.variableSnapshot };
          let changed = false;
          named.forEach((v) => {
            if (snapshot[v.name] === undefined) {
              snapshot[v.name] = snapValue(v);
              changed = true;
            }
          });
          if (reset) {
            // Confirmed regeneration → clear every card's image regardless
            // of whether a named value was folded in (the new variable may
            // still be unnamed at this point).
            touched = true;
            return {
              ...card,
              variableSnapshot: snapshot,
              imageUrl: null,
              status: "idle" as const,
              queuePosition: undefined,
            };
          }
          if (!changed) return card;
          touched = true;
          return { ...card, variableSnapshot: snapshot };
        });
        // Returning the same reference when nothing changed avoids an
        // effect ↔ setVersions feedback loop (a lingering unnamed variable
        // keeps `missing` true, but must not keep re-rendering).
        return touched ? next : prev;
      });
    },
    [variables]
  );

  /* Detect when a brand-new variable (added via the + button, by typing a
     new `[token]`, or by converting a selection) isn't yet reflected in the
     parked verify cards. New is determined by variable id, so a variable
     that already existed when the cards were generated never counts — only
     genuinely added ones do. If the cards have no images yet the variable is
     folded in silently; if they already have generated images we ask first,
     because applying it means regenerating (which clears them). */
  useEffect(() => {
    if (!versionsReadyRef.current) return;
    if (ui.editingNameVarId) return; // don't fire mid-typing of a name
    const currentIds = variables.map((v) => v.id);
    // Prime on the first run after restore so pre-existing variables aren't
    // mistaken for new additions.
    if (!varSyncPrimedRef.current) {
      varSyncPrimedRef.current = true;
      syncedVarIdsRef.current = new Set(currentIds);
      return;
    }
    if (versions.length === 0) {
      syncedVarIdsRef.current = new Set(currentIds);
      return;
    }
    const hasNew = currentIds.some((id) => !syncedVarIdsRef.current.has(id));
    if (!hasNew) {
      syncedVarIdsRef.current = new Set(currentIds); // prune removed ids
      return;
    }
    const hasImages = versions.some((v) => v.imageUrl || v.status === "complete");
    if (!hasImages) {
      applyVarSyncToVersions(false);
      syncedVarIdsRef.current = new Set(currentIds);
      return;
    }
    // Remember exactly which variables are new so "No" can undo them.
    pendingNewVarIdsRef.current = currentIds.filter(
      (id) => !syncedVarIdsRef.current.has(id)
    );
    setUi((p) => (p.pendingVarSync ? p : { ...p, pendingVarSync: true }));
  }, [variables, versions, ui.editingNameVarId, applyVarSyncToVersions]);

  /* Undo a just-added variable when the user answers "No" to the
     "recreate the images?" prompt: drop the variable(s) and turn their
     `[token]` back into plain text so nothing the user typed is lost. */
  const revertNewVariables = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const removed = variables.filter((v) => idSet.has(v.id));
    if (removed.length === 0) return;
    setPromptData((prev) => {
      let body = prev.body;
      removed.forEach((v) => {
        const inner = v.fullToken.replace(/^\[/, "").replace(/\]$/, "");
        body = body.split(v.fullToken).join(inner);
      });
      return { ...prev, body };
    });
    setVariables((prev) => prev.filter((v) => !idSet.has(v.id)));
  }, [variables]);

  /* ─── Undo / Redo implementation ─── */
  const applySnapshot = useCallback((snap: EditorSnapshot) => {
    isApplyingHistoryRef.current = true;
    setPromptData(snap.promptData);
    setVariables(snap.variables);
    setModels((prev) => ({ ...prev, selected: snap.modelsSelected.slice(0, 1) }));
    setRatios((prev) => ({ ...prev, selected: snap.ratiosSelected }));
    setReferenceImages(snap.referenceImages);
  }, []);

  /* Capture the user's current focus (prompt textarea or a variable's
     name/description input) so undo/redo can restore where they were. */
  const captureFocusContext = useCallback((): FocusContext => {
    if (typeof document === "undefined") return null;
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    if (el === textareaRef.current) {
      const ta = el as HTMLTextAreaElement;
      return { type: "textarea", cursorPos: ta.selectionStart ?? 0 };
    }
    const isName = el.classList.contains("enk-var-card__name-input");
    const isDesc = el.classList.contains("enk-var-card__desc-input");
    if (!isName && !isDesc) return null;
    for (const [varId, card] of Object.entries(variableCardRefs.current)) {
      if (card && card.contains(el)) {
        const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
        return { type: isName ? "varName" : "varDesc", varId, cursorPos: inputEl.selectionStart ?? 0 };
      }
    }
    return null;
  }, []);

  const restoreFocusContext = useCallback((ctx: FocusContext) => {
    if (!ctx) return;
    if (ctx.type === "textarea") {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      const safe = Math.min(ctx.cursorPos, ta.value.length);
      try {
        ta.setSelectionRange(safe, safe);
      } catch {
        /* ignored */
      }
      return;
    }
    const card = variableCardRefs.current[ctx.varId];
    if (!card) return;
    const selector =
      ctx.type === "varName" ? ".enk-var-card__name-input" : ".enk-var-card__desc-input";
    const input = card.querySelector(selector) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (!input) return;
    input.focus();
    const safe = Math.min(ctx.cursorPos, input.value.length);
    try {
      input.setSelectionRange(safe, safe);
    } catch {
      /* ignored */
    }
  }, []);

  const captureSnapshot = useCallback(
    (): EditorSnapshot => ({
      promptData,
      variables,
      modelsSelected: models.selected,
      ratiosSelected: ratios.selected,
      referenceImages,
    }),
    [promptData, variables, models.selected, ratios.selected, referenceImages]
  );

  const snapshotsEqual = useCallback(
    (a: EditorSnapshot, b: EditorSnapshot): boolean => {
      if (a === b) return true;
      const stripFocus = ({ focus: _focus, ...rest }: EditorSnapshot) => rest;
      return JSON.stringify(stripFocus(a)) === JSON.stringify(stripFocus(b));
    },
    []
  );

  /* A snapshot is "coherent" iff every `[token]` in the body has a
     matching variable and vice-versa (counts match). We refuse to
     record incoherent states that appear transiently between the body
     edit and the 400 ms variable-sync effect, so undo never lands on a
     half-built editor. */
  const isSnapshotCoherent = useCallback((snap: EditorSnapshot): boolean => {
    const bodyTokenCounts = new Map<string, number>();
    const tokenRe = /\[[^\]]*\]/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(snap.promptData.body)) !== null) {
      bodyTokenCounts.set(m[0], (bodyTokenCounts.get(m[0]) ?? 0) + 1);
    }
    const varTokenCounts = new Map<string, number>();
    for (const v of snap.variables) {
      varTokenCounts.set(v.fullToken, (varTokenCounts.get(v.fullToken) ?? 0) + 1);
    }
    if (bodyTokenCounts.size !== varTokenCounts.size) return false;
    for (const [token, count] of bodyTokenCounts) {
      if (varTokenCounts.get(token) !== count) return false;
    }
    return true;
  }, []);

  /* Force-commit any pending debounced snapshot now (used before
     undo/redo so a half-typed change becomes its own step). */
  const flushPendingSnapshot = useCallback(() => {
    if (!historyDebounceRef.current) return;
    clearTimeout(historyDebounceRef.current);
    historyDebounceRef.current = null;
    const baseline = historySnapshotRef.current;
    if (!baseline) return;
    const current = captureSnapshot();
    if (snapshotsEqual(baseline, current)) return;
    if (!isSnapshotCoherent(current)) return;
    const baselineWithFocus: EditorSnapshot = {
      ...baseline,
      focus: gestureFocusRef.current ?? null,
    };
    historyPastRef.current.push(baselineWithFocus);
    if (historyPastRef.current.length > HISTORY_LIMIT) {
      historyPastRef.current.shift();
    }
    historyFutureRef.current = [];
    historySnapshotRef.current = current;
    gestureFocusRef.current = undefined;
  }, [captureSnapshot, snapshotsEqual, isSnapshotCoherent]);

  /* Push a snapshot onto the past stack (debounced 350 ms) whenever the
     tracked state changes — coalescing a burst of edits into one step. */
  useEffect(() => {
    if (!draftReadyRef.current) return;
    if (isApplyingHistoryRef.current) {
      isApplyingHistoryRef.current = false;
      historySnapshotRef.current = captureSnapshot();
      return;
    }
    if (historySnapshotRef.current === null) {
      historySnapshotRef.current = captureSnapshot();
      return;
    }
    if (gestureFocusRef.current === undefined) {
      gestureFocusRef.current = captureFocusContext();
    }
    if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current);
    historyDebounceRef.current = setTimeout(() => {
      historyDebounceRef.current = null;
      const baseline = historySnapshotRef.current;
      if (!baseline) {
        historySnapshotRef.current = captureSnapshot();
        return;
      }
      const next = captureSnapshot();
      if (snapshotsEqual(baseline, next)) return;
      if (!isSnapshotCoherent(next)) return;
      const baselineWithFocus: EditorSnapshot = {
        ...baseline,
        focus: gestureFocusRef.current ?? null,
      };
      historyPastRef.current.push(baselineWithFocus);
      if (historyPastRef.current.length > HISTORY_LIMIT) {
        historyPastRef.current.shift();
      }
      historyFutureRef.current = [];
      historySnapshotRef.current = next;
      gestureFocusRef.current = undefined;
      setHistoryVersion((v) => v + 1);
    }, 350);
  }, [
    promptData,
    variables,
    models.selected,
    ratios.selected,
    referenceImages,
    captureSnapshot,
    captureFocusContext,
    snapshotsEqual,
    isSnapshotCoherent,
  ]);

  const restoreFocusForHistoryStep = useCallback(
    (snap: EditorSnapshot) => {
      requestAnimationFrame(() => {
        restoreFocusContext(snap.focus ?? null);
      });
    },
    [restoreFocusContext]
  );

  const handleUndo = useCallback(() => {
    flushPendingSnapshot();
    if (historyPastRef.current.length === 0) return;
    const target = historyPastRef.current.pop()!;
    const currentForFuture: EditorSnapshot = {
      ...(historySnapshotRef.current ?? captureSnapshot()),
      focus: target.focus ?? null,
    };
    historyFutureRef.current.push(currentForFuture);
    applySnapshot(target);
    historySnapshotRef.current = target;
    setHistoryVersion((v) => v + 1);
    restoreFocusForHistoryStep(target);
  }, [applySnapshot, captureSnapshot, flushPendingSnapshot, restoreFocusForHistoryStep]);

  const handleRedo = useCallback(() => {
    flushPendingSnapshot();
    if (historyFutureRef.current.length === 0) return;
    const target = historyFutureRef.current.pop()!;
    const currentForPast: EditorSnapshot = {
      ...(historySnapshotRef.current ?? captureSnapshot()),
      focus: target.focus ?? null,
    };
    historyPastRef.current.push(currentForPast);
    applySnapshot(target);
    historySnapshotRef.current = target;
    setHistoryVersion((v) => v + 1);
    restoreFocusForHistoryStep(target);
  }, [applySnapshot, captureSnapshot, flushPendingSnapshot, restoreFocusForHistoryStep]);

  /* Keyboard shortcuts: Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo
     (Cmd-equivalents on Mac). We intercept even inside the textarea so
     native textarea undo can't desync from our snapshot stack. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleUndo, handleRedo]);

  const canUndo = historyVersion >= 0 && historyPastRef.current.length > 0;
  const canRedo = historyVersion >= 0 && historyFutureRef.current.length > 0;

  /* ─── Clean slate ───
     Resets all editor content + settings, clears the persisted draft
     (localStorage) and verify cards (IndexedDB), and empties the
     undo/redo history so there's nothing to roll back into. */
  const resetEditor = useCallback(() => {
    setPromptData({ title: "", body: "", type: "free-prompt", tags: [] });
    setVariables([]);
    setReferenceImages([]);
    setVersions([]);
    setModels((prev) => ({ ...prev, selected: [] }));
    setRatios((prev) => ({ ...prev, selected: "Any ratio" }));
    setPromptPrice(0);
    setPriceText("");
    setUi((p) => ({
      ...p,
      selectedCards: [],
      tagInput: "",
      pricePerRenderReviewed: false,
      selectedVariableId: null,
      editingNameVarId: null,
      variableNameConflict: null,
      pendingTypeChange: null,
      confirmNewOpen: false,
      // A new draft is unsaved — a stale id would route it through the
      // intent flow priced from the OLD prompt's DB row.
      currentPromptId: null,
    }));
    try {
      localStorage.removeItem(EDITOR_DRAFT_KEY);
    } catch {
      /* ignore storage errors */
    }
    void clearEditorVersions();
    syncedVarIdsRef.current = new Set();
    varSyncPrimedRef.current = false;
    historyPastRef.current = [];
    historyFutureRef.current = [];
    historySnapshotRef.current = null;
    gestureFocusRef.current = undefined;
    setHistoryVersion((v) => v + 1);
  }, []);

  /* ─── New prompt — wipe everything and say so ─── */
  const handleNewPrompt = useCallback(() => {
    resetEditor();
    toast({ title: "New prompt", description: "Cleared the editor — starting fresh." });
  }, [resetEditor, toast]);

  /* ─── ESC → leave the editor ───
     A neutral ESC (no lightbox/dialog/dropdown open, nothing prevented it)
     asks save-or-discard when there's content. "Save" simply keeps the
     already-autosaved localStorage draft and returns home; "Discard" wipes
     it via handleNewPrompt. */
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const leaveConfirmRef = useRef(false); leaveConfirmRef.current = leaveConfirm;
  const editorDirtyRef = useRef(false);
  useEffect(() => {
    editorDirtyRef.current = !!(
      promptData.title.trim() || promptData.body.trim() || variables.length || referenceImages.length
    );
  }, [promptData, variables, referenceImages]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture-phase snapshot: is any overlay open right now? (After the other
      // handlers run it may already be closed — this ESC belonged to it.)
      const overlayOpen =
        leaveConfirmRef.current ||
        document.body.classList.contains("enk-ref-preview-open") ||
        !!document.querySelector('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper], .wp-scope');
      // Defer the decision so inner handlers (mention dropdown, lightbox…) can
      // claim the key via preventDefault first.
      setTimeout(() => {
        if (overlayOpen || e.defaultPrevented) return;
        if (!editorDirtyRef.current) { router.push("/home"); return; }
        setLeaveConfirm(true);
      }, 0);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [router]);

  const addReferenceImage = (file: File) => {
    if (referenceImages.length >= ui.maxImages) {
      toast({
        title: "Limit reached",
        description: `You can add up to ${ui.maxImages} reference image(s).`,
        variant: "destructive",
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = String(e.target?.result || "");
      if (dataUrl) setReferenceImages((prev) => [...prev, dataUrl]);
    };
    reader.readAsDataURL(file);
  };

  const pickReferenceImages = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = (ev) => {
      const files = Array.from((ev.target as HTMLInputElement).files || []);
      files.forEach(addReferenceImage);
    };
    input.click();
  };

  const reorderReferenceImages = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    setReferenceImages((prev) => {
      if (from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  /* ─── External file drag-and-drop into the reference zone ──────
     The HTML5 drag events bubble through every child element of the
     drop zone, so dragenter/dragleave fire many times during a
     single drag. We use a counter ref to track the *net* enter/leave
     state and only flip `externalDragActive` when the cursor truly
     leaves the zone (counter === 0). `Files` in dataTransfer.types
     is the well-known way to detect an external file drag (vs. an
     internal HTML element drag). */
  const handleRefZoneDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    externalDragCounterRef.current += 1;
    if (!externalDragActive) setExternalDragActive(true);
  }, [externalDragActive]);

  const handleRefZoneDragLeave = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    externalDragCounterRef.current = Math.max(0, externalDragCounterRef.current - 1);
    if (externalDragCounterRef.current === 0) setExternalDragActive(false);
  }, []);

  const handleRefZoneDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    // preventDefault is REQUIRED for `drop` to fire on this element.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleRefZoneDrop = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    externalDragCounterRef.current = 0;
    setExternalDragActive(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith("image/")
    );
    files.forEach(addReferenceImage);
  }, [addReferenceImage]);

  /* ─── @-mention dropdown helpers ───
     Filtered matches: all reference images whose 1-based label
     ("Image 1", "Image 2", ...) starts with — or contains —
     whatever the user typed after the leading @. Numeric queries
     match by image index ("@2" → Image 2). Empty query shows all. */
  const mentionMatches = mention.open
    ? referenceImages
        .map((src, idx) => ({ src, idx, label: `Image ${idx + 1}` }))
        .filter(({ label, idx }) => {
          const q = mention.query.toLowerCase();
          if (!q) return true;
          if (label.toLowerCase().includes(q)) return true;
          if (/^\d/.test(q) && String(idx + 1).startsWith(q)) return true;
          return false;
        })
    : [];

  /* Replace the active @<query> at the caret with `@Image{N}` and
     a single trailing space (so the user can keep typing without
     having to manually re-space). Caret is repositioned right
     after the inserted space so subsequent input flows naturally. */
  /* ─── Price stepper ───
     Bumps the price by `delta` USDC, clamps to the allowed minimum,
     rounds to 4-decimal precision (matches the input's `step`),
     snapshots the previous value (for digit-diff animation) and
     triggers the roll-direction class. The class self-clears 240ms
     later — long enough for the keyframe to play, short enough that
     rapid clicks restart cleanly. */
  const handlePriceStep = useCallback(
    (delta: number) => {
      const current = promptPrice || 0;
      const next = Math.max(
        0.0001,
        parseFloat((current + delta).toFixed(4))
      );
      if (next === current) return;
      prevPriceRollSnapshotRef.current = current;
      priceRollKeyRef.current += 1;
      setPriceRollDir(delta > 0 ? "up" : "down");
      setPromptPrice(next);
      setUi((p) => ({ ...p, pricePerRenderReviewed: true }));
      if (priceRollTimerRef.current) clearTimeout(priceRollTimerRef.current);
      priceRollTimerRef.current = setTimeout(() => {
        setPriceRollDir(null);
        priceRollTimerRef.current = null;
      }, 240);
    },
    [promptPrice]
  );

  /* ─── Max-User-Images stepper ─── (mirrors handlePriceStep) */
  const handleMaxImagesStep = useCallback((delta: number) => {
    setUi((p) => {
      const current = p.maxImages;
      const next = Math.min(10, Math.max(1, current + delta));
      if (next === current) return p;
      prevMaxImagesRollSnapshotRef.current = current;
      maxImagesRollKeyRef.current += 1;
      setMaxImagesRollDir(delta > 0 ? "up" : "down");
      if (maxImagesRollTimerRef.current) clearTimeout(maxImagesRollTimerRef.current);
      maxImagesRollTimerRef.current = setTimeout(() => {
        setMaxImagesRollDir(null);
        maxImagesRollTimerRef.current = null;
      }, 240);
      return { ...p, maxImages: next };
    });
  }, []);

  const insertReferenceImageMention = useCallback(
    (imageIndex: number) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const caret = ta.selectionStart;
      const start = mention.startPos;
      if (start < 0 || start > caret) return;
      const token = `@Image${imageIndex + 1}`;
      const before = promptData.body.substring(0, start);
      const after = promptData.body.substring(caret);
      const needsSpace = !after.startsWith(" ");
      const insertion = token + (needsSpace ? " " : "");
      const newBody = before + insertion + after;
      setPromptData((prev) => ({ ...prev, body: newBody }));
      setMention({ open: false, query: "", startPos: -1, highlighted: 0 });
      const newCaret = start + insertion.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(newCaret, newCaret);
      });
    },
    [mention.startPos, promptData.body]
  );

  /* Compute the dropdown anchor — viewport-relative pixel coords of
     the `@` glyph itself, NOT the textarea-box's bottom edge. This
     places the dropdown directly under the `@` exactly where the
     user is typing. The position-1 caret coordinate is the position
     RIGHT BEFORE the `@`; we want the line below the `@`'s line, so
     we add the line-height to `top`.
       deps:
         - `mention.open`     — bind/unbind on open/close
         - `mention.startPos` — re-anchor if a paste shifts the @
         - `promptData.body`  — re-measure if textarea wraps differently
       NOT depended on:
         - `mentionAnchor`    — `update()` always returns a fresh
           object, including it would cause an infinite render loop.

     Refreshes on scroll (capture phase) + resize + ResizeObserver
     so the anchor follows the caret if the page reflows. */
  useEffect(() => {
    if (!mention.open) {
      setMentionAnchor((prev) => (prev !== null ? null : prev));
      return;
    }
    const update = () => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = mention.startPos >= 0 ? mention.startPos : 0;
      const caret = getCaretCoordinates(ta, pos);
      setMentionAnchor({
        /* `top` = the visual baseline of the @ + one line height +
           a small breathing-room offset, so the dropdown sits just
           UNDER the line containing the @. */
        top: caret.top + caret.height + 4,
        left: caret.left,
        width: 0,                         // unused; CSS sizes via content
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && textareaRef.current) {
      ro = new ResizeObserver(update);
      ro.observe(textareaRef.current);
    }
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      ro?.disconnect();
    };
  }, [mention.open, mention.startPos, promptData.body]);

  /* ─── Reference-image lightbox keyboard nav ───
     Active only while the preview is open (refPreviewIndex !== null).
       • Escape       → close
       • ArrowLeft    → previous (wraps)
       • ArrowRight   → next     (wraps)
     We also lock document scroll while the lightbox is mounted so
     the page underneath doesn't move when arrowing through images. */
  useEffect(() => {
    if (refPreviewIndex === null) return;
    const total = referenceImages.length;
    if (total === 0) {
      setRefPreviewIndex(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setRefPreviewIndex(null);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setRefPreviewDirection("prev");
        setRefPreviewIndex((i) => (i === null ? null : (i - 1 + total) % total));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setRefPreviewDirection("next");
        setRefPreviewIndex((i) => (i === null ? null : (i + 1) % total));
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    /* Mark the document body so any UI chrome OUTSIDE the lightbox
       (navbar, sticky headers, toasts, etc.) can react via CSS —
       e.g. fade out + grayscale — instead of peeking through the
       backdrop blur. The class is removed on cleanup. */
    document.body.classList.add("enk-ref-preview-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      document.body.classList.remove("enk-ref-preview-open");
    };
  }, [refPreviewIndex, referenceImages.length]);

  /* ─── Model Sync ───
     Nothing is auto-selected. fetchedModels[0] is the cheapest row (Flux),
     so the auto-pick quietly made the free model "the selection" (Kev,
     2026-10-02: "IMMER DAS AUSGEWÄHLTE"). */
  useEffect(() => {
    if (fetchedModels.length > 0) {
      setModels(prev => ({ ...prev, available: fetchedModels }));
    }
  }, [fetchedModels]);

  /* The ONE model a generation runs: the selected chip, resolved against the
     catalogue (which knows whether it is free and what it supports). */
  const catalogue = useModelCatalogue();
  const picked = resolveCatalogueEntry(catalogue, models.selected[0]);
  const genTiers = useMemo(() => (picked ? tiersUpTo(picked.maxResolution) : []), [picked]);
  const [chosenResolution, setGenResolution] = useState<"1K" | "2K" | "4K">("2K");
  // A tier the model cannot render runs at its ceiling, derived rather than
  // written back, so the pick returns when a bigger model is chosen again.
  const genResolution = genTiers.length && !genTiers.includes(chosenResolution)
    ? genTiers[genTiers.length - 1]
    : chosenResolution;

  /* Every price shown is a server quote (Kev, 2026-10-02: "ich brauche safe
     überall den server-quote"): each paid model at the current settings, one
     request. The per-slot price was the catalogue price with a $0.10
     fallback, without the fee and without quality. */
  const pricedEntries = catalogue.filter((m) => !m.free);
  const entryQuotes = useServerQuotes(
    pricedEntries.map((m) => ({
      modelId: m.id,
      resolution: genResolution,
      quality: m.supportsQuality ? quality : undefined,
      boost: boost && !!m.boostAvailable,
    })),
  );
  const modelPriceLabel = (id: string): string | undefined => {
    const m = catalogue.find((c) => c.id === id);
    if (!m) return undefined;
    if (m.free) return "Free";
    return quoteLabel(entryQuotes[pricedEntries.indexOf(m)]) ?? undefined;
  };
  /** The selected model's server quote for n images, "Free", or "…". */
  const slotPrice = (n: number): string =>
    !picked ? "" : picked.free ? "Free" : quoteLabel(entryQuotes[pricedEntries.indexOf(picked)], n) ?? "…";

  /* ─── Ratio Sync ─── */
  useEffect(() => {
    if (models.selected.length > 0 && models.available.length > 0) {
      const allowed = new Set<string>();
      models.selected.forEach(modelId => {
        const m = models.available.find(x => x.id === modelId);
        if (m && m.allowed_ratios) {
          m.allowed_ratios.forEach((r: string) => allowed.add(r));
        }
      });
      const allowedArray = Array.from(allowed);
      setRatios(prev => ({
        ...prev,
        available: allowedArray,
        // Default to "Any ratio" whenever the current pick isn't valid,
        // instead of falling back to the model's first allowed ratio.
        selected: allowedArray.includes(prev.selected) ? prev.selected : "Any ratio"
      }));
    }
  }, [models.selected, models.available]);

  // Every generator accepts a different set, so the list comes from the models
  // table (models.allowed_ratios), narrowed to the selected models by the Ratio
  // Sync effect above. It used to be a constant here that offered 4:5, 3:2 and
  // 21:9 — none of which the provider accepts, so picking one failed the
  // generation AFTER the payment had settled.
  const offeredRatios = useMemo(
    () => ["Any ratio", ...(ratios.available.length > 0 ? ratios.available : FALLBACK_RATIOS)],
    [ratios.available],
  );

  // "Any ratio" is a UI choice, not a provider value — it means "don't ask for
  // one". It used to be sent verbatim, and since it is the DEFAULT selection,
  // Gemini's validator rejected it: the paid path failed unless the user
  // happened to change the ratio. Sending undefined lets the server apply its
  // own default instead.
  const ratioForApi = ratios.selected === "Any ratio" ? undefined : ratios.selected;

  // One model. Several chips used to light up while only the first ran.
  const toggleModel = (modelId: string) => {
    setModels(prev => ({ ...prev, selected: [modelId] }));
  };

  /* ─── Real-time Variable Sync — detects [] brackets only ─── */
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      // Only detect square brackets as variables: [content]
      const regex = /\[([^\]]+)\]/g;
      const detections: { content: string; full: string }[] = [];
      let match;
      while ((match = regex.exec(promptData.body)) !== null) {
        const content = match[1];
        if (content) detections.push({ content, full: match[0] });
      }

      setVariables((prev) => {
        const detectionByToken = new Map(detections.map((d) => [d.full, d]));
        const merged: PromptVariable[] = [];
        const seenTokens = new Set<string>();

        // Keep existing variables in list order; drop tokens removed from prompt
        for (const existing of prev) {
          if (!detectionByToken.has(existing.fullToken)) continue;
          merged.push(normalizeVariable(existing, merged));
          seenTokens.add(existing.fullToken);
        }

        // Append newly detected tokens at the end (never insert at top)
        for (const det of detections) {
          if (seenTokens.has(det.full)) continue;
          seenTokens.add(det.full);
          const stableId = `var-${Math.random().toString(36).substring(2, 9)}`;
          const draft: PromptVariable = {
            id: stableId,
            name: "",
            label: det.content,
            description: det.content,
            type: "text",
            defaultValue: det.content,
            values: [det.content],
            required: true,
            position: merged.length,
            fullToken: det.full,
            colorIndex: pickVariableColorIndex(merged),
          };
          merged.push(normalizeVariable(draft, merged));
        }
        return merged;
      });
    }, 400);

    return () => clearTimeout(timeoutId);
  }, [promptData.body]);

  useEffect(() => {
    variableLabelRegistryRef.current = buildLabelRegistry(variables, promptData.body);
  }, [variables, promptData.body]);

  /* ─── Cursor Fix & Insertion ─── */
  const insertAtCursor = (text: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const val = promptData.body;
    const newVal = val.substring(0, start) + text + val.substring(end);

    setPromptData(prev => ({ ...prev, body: newVal }));

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + text.length;
        textareaRef.current.focus();
      }
    });
  };

  /* ─── Bracket Deletion — restores default value ─── */
  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    /* @-mention dropdown navigation. Intercepts ↑/↓/Enter/Tab/Escape
       BEFORE the normal backspace/delete logic so the dropdown can
       commandeer those keys while it's open. Any other key falls
       through (and onChange will close the dropdown if needed). */
    if (mention.open && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention((m) => ({
          ...m,
          highlighted: Math.min(mentionMatches.length - 1, m.highlighted + 1),
        }));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention((m) => ({ ...m, highlighted: Math.max(0, m.highlighted - 1) }));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const idx = Math.min(mention.highlighted, mentionMatches.length - 1);
        const item = mentionMatches[idx];
        if (item) insertReferenceImageMention(item.idx);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention((m) => ({ ...m, open: false }));
        return;
      }
    }

    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    const el = e.currentTarget;
    const pos = el.selectionStart;
    const text = promptData.body;

    // Check if we are deleting the closing bracket of a variable
    const charBefore = text[pos - 1];
    const isClosing = charBefore === ']';
    
    if (isClosing) {
      // Find the start of the bracket group
      const openChar = '[';
      let startPos = pos - 2;
      while (startPos >= 0 && text[startPos] !== openChar) startPos--;
      
      if (startPos >= 0) {
        const fullToken = text.substring(startPos, pos);
        const variable = variables.find(v => v.fullToken === fullToken);
        
        if (variable) {
          e.preventDefault();
          const restoredText = getVariableReplacementText(variable);
          const newBody = text.substring(0, startPos) + restoredText + text.substring(pos);
          setPromptData(prev => ({ ...prev, body: newBody }));
          setVariables((prev) => prev.filter((v) => v.id !== variable.id));
          
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              const newCursor = startPos + restoredText.length;
              textareaRef.current.selectionStart = textareaRef.current.selectionEnd = newCursor;
              textareaRef.current.focus();
            }
          });
        }
      }
    }
  };

  const triggerVariablePulse = useCallback((varId: string) => {
    if (variablePulseTimerRef.current) clearTimeout(variablePulseTimerRef.current);
    setUi((p) => ({ ...p, variablePulsingId: varId }));
    variablePulseTimerRef.current = setTimeout(() => {
      setUi((p) => ({ ...p, variablePulsingId: null }));
    }, 2200);
  }, []);

  const scrollVariableCardIntoView = useCallback((varId: string) => {
    let attempts = 0;
    const tryScroll = () => {
      const el = variableCardRefs.current[varId];
      const scrollRoot = variablesScrollRef.current;
      if (!el || !scrollRoot) {
        if (attempts++ < 20) requestAnimationFrame(tryScroll);
        return;
      }
      const elRect = el.getBoundingClientRect();
      const rootRect = scrollRoot.getBoundingClientRect();
      scrollRoot.scrollTo({
        top: scrollRoot.scrollTop + (elRect.top - rootRect.top) - 12,
        behavior: "auto",
      });
    };
    tryScroll();
  }, []);

  const selectVariable = useCallback(
    (
      id: string,
      options?: { scrollToCard?: boolean; cursorPos?: number; pulse?: boolean }
    ) => {
      setUi((prev) => ({
        ...prev,
        selectedVariableId: id,
        ...(options?.cursorPos != null ? { cursorPos: options.cursorPos } : {}),
      }));
      if (options?.pulse) triggerVariablePulse(id);
      if (options?.scrollToCard) scrollVariableCardIntoView(id);
    },
    [triggerVariablePulse, scrollVariableCardIntoView]
  );

  const selectVariableAtCursor = useCallback(
    (el: HTMLTextAreaElement) => {
      const start = el.selectionStart;
      const text = promptData.body;
      const regex = /\[([^\]]+)\]/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        if (start >= match.index && start <= match.index + match[0].length) {
          const variable = variables.find((v) => v.fullToken === match![0]);
          if (variable) {
            selectVariable(variable.id, { scrollToCard: true, pulse: true });
            return true;
          }
          break;
        }
      }
      return false;
    },
    [promptData.body, variables, selectVariable]
  );

  /* ─── AI Variable Naming ─── */
  const handleTextareaSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = promptData.body;
    setUi(prev => ({ ...prev, cursorPos: start }));

    selectVariableAtCursor(el);

    if (end > start) {
      const selectedText = text.substring(start, end);
      const rect = el.getBoundingClientRect();
      // Approximate tooltip position near cursor
      const x = rect.left + 50;
      const y = rect.top;

      setUi(prev => ({ ...prev, tooltip: { x, y, text: selectedText } }));
    } else {
      setUi(prev => ({ ...prev, tooltip: null }));
    }
  };

  const handleCreateVariable = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    const selStart = el.selectionStart;
    const selEnd = el.selectionEnd;
    const val = promptData.body;
    const rawSelected = val.substring(selStart, selEnd);
    const innerRaw = rawSelected.trim();
    if (!innerRaw) return;

    const leadingPad = rawSelected.length - rawSelected.trimStart().length;
    const trailingPad = rawSelected.length - rawSelected.trimEnd().length;
    const varStart = selStart + leadingPad;
    const varEnd = selEnd - trailingPad;

    const inner = takeUniqueVariableLabel(
      variableLabelRegistryRef,
      innerRaw,
      variables,
      promptData.body
    );
    const bracketed = buildFullToken(inner);
    const newVal = val.substring(0, varStart) + bracketed + val.substring(varEnd);

    const stableId = `var-${Math.random().toString(36).substring(2, 9)}`;

    setPromptData((prev) => ({ ...prev, body: newVal }));
    setVariables((prev) => {
      const draft: PromptVariable = {
        id: stableId,
        name: "",
        label: inner,
        description: inner,
        type: "text",
        defaultValue: inner,
        values: [inner],
        required: true,
        position: prev.length,
        fullToken: bracketed,
        colorIndex: pickVariableColorIndex(prev),
      };
      return [...prev, normalizeVariable(draft, prev)];
    });
    pendingVarScrollRef.current = stableId;
    setUi((prev) => ({ ...prev, tooltip: null }));
    selectVariable(stableId, { scrollToCard: true, pulse: true });

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const caret = varStart + bracketed.length;
        textareaRef.current.selectionStart = caret;
        textareaRef.current.selectionEnd = caret;
        textareaRef.current.focus();
      }
    });
  }, [promptData.body, variables, selectVariable]);

  const handleVariableButtonClick = () => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selectedText = promptData.body.substring(start, end);

    if (start !== end && selectedText.trim()) {
      handleCreateVariable();
      return;
    }

    let insertedLen = 0;
    setPromptData((prev) => {
      const inner = takeUniqueVariableLabel(
        variableLabelRegistryRef,
        "Variable",
        variables,
        prev.body
      );
      const token = buildFullToken(inner);
      insertedLen = token.length;
      return {
        ...prev,
        body: prev.body.substring(0, start) + token + prev.body.substring(end),
      };
    });
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const caret = start + insertedLen;
        textareaRef.current.selectionStart = caret;
        textareaRef.current.selectionEnd = caret;
        textareaRef.current.focus();
      }
    });
  };

  const createVariableFromSelection = () => {
    if (!ui.tooltip) return;
    handleCreateVariable();
  };

  // Keep the overlay's right padding == textarea's right padding + scrollbar
  // gutter. The textarea uses `scrollbar-gutter: stable`, which reserves
  // ~8px inside the textarea's content area. The overlay has no scrollbar,
  // so we add that same gutter to its padding-right at runtime. Without
  // this, both layers would technically have the same box width but the
  // textarea would wrap text earlier (gutter eats space), making the
  // cursor drift by one column → eventually one full line.
  // PROMPT_PAD_X must equal `--enk-prompt-pad-x` in enki-editor.css.
  const syncPromptOverlayMetrics = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const scrollbar = Math.max(0, ta.offsetWidth - ta.clientWidth);
    const padRight = `${PROMPT_PAD_X + scrollbar}px`;
    for (const el of [overlayRef.current, hitOverlayRef.current]) {
      if (!el) continue;
      el.style.paddingRight = padRight;
    }
  }, []);

  // Copy the textarea's scroll position to both overlay layers. Cheap
  // (a couple of property writes) and guarded so it's a no-op when the
  // values already match. Used both by the `scroll` event handler and
  // by the continuous rAF sync loop below.
  const syncOverlayScroll = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const top = ta.scrollTop;
    const left = ta.scrollLeft;
    const overlay = overlayRef.current;
    if (overlay) {
      if (overlay.scrollTop !== top) overlay.scrollTop = top;
      if (overlay.scrollLeft !== left) overlay.scrollLeft = left;
    }
    const hit = hitOverlayRef.current;
    if (hit) {
      if (hit.scrollTop !== top) hit.scrollTop = top;
      if (hit.scrollLeft !== left) hit.scrollLeft = left;
    }
  }, []);

  const handleTextareaScroll = useCallback(() => {
    syncOverlayScroll();
    syncPromptOverlayMetrics();
  }, [syncOverlayScroll, syncPromptOverlayMetrics]);

  // ─── Bulletproof scroll sync ──────────────────────────────────────
  // The textarea's `scroll` event alone is NOT sufficient: when the
  // browser auto-scrolls the textarea to bring the caret into view
  // (e.g. after a paste, after clicking past the visible area, or
  // after an arrow-key/Page-Down navigation), it sometimes fires the
  // `scroll` event AFTER the next paint — so for at least one frame
  // the caret blinks at the new (post-scroll) position while the
  // overlay still shows the OLD content. Result: the user sees the
  // cursor in the middle of the wrong line until they manually scroll
  // (which finally fires `scroll` and resyncs).
  //
  // To make this impossible, we run a continuous requestAnimationFrame
  // loop while the textarea is focused. It does nothing more than
  // mirror scrollTop/scrollLeft, and bails immediately when values
  // already match, so the cost is negligible (a few number reads per
  // frame) but it's guaranteed to catch every browser-driven scroll.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    let rafId: number | null = null;
    const tick = () => {
      syncOverlayScroll();
      rafId = requestAnimationFrame(tick);
    };
    const start = () => {
      if (rafId !== null) return;
      // Immediate sync covers the moment between focus and the first
      // rAF tick (~16ms later) where the browser may already have
      // auto-scrolled.
      syncOverlayScroll();
      rafId = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      // One last sync after blur in case a final scroll happened.
      syncOverlayScroll();
    };
    ta.addEventListener("focus", start);
    ta.addEventListener("blur", stop);
    if (typeof document !== "undefined" && document.activeElement === ta) {
      start();
    }
    return () => {
      stop();
      ta.removeEventListener("focus", start);
      ta.removeEventListener("blur", stop);
    };
  }, [syncOverlayScroll]);

  useEffect(() => {
    const run = () => syncPromptOverlayMetrics();
    run();
    const raf = requestAnimationFrame(run);
    const ta = textareaRef.current;
    if (!ta) return () => cancelAnimationFrame(raf);
    const ro = new ResizeObserver(run);
    ro.observe(ta);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [promptData.body, syncPromptOverlayMetrics]);

  /** Colored variable marks in the prompt — plain text stays unwrapped for cursor alignment */
  const renderPromptWithTags = (layer: "display" | "hit" = "display") => {
    const parts = promptData.body.split(PROMPT_INLINE_TOKEN_RE);
    return parts.map((part, index) => {
      if (!part) return null;

      /* `@Image{N}` reference-image mention. Rendered as a chip
         with grey bg + dark grey text PLUS a tiny thumbnail of the
         actual reference image at the left edge.

         CRITICAL: padding/margin must stay 0 so the chip's painted
         box matches the textarea text glyphs char-for-char,
         otherwise the cursor desyncs. The thumbnail is therefore
         rendered via a `::before` pseudo element with
         `position: absolute` — it has zero layout impact and just
         visually occludes the `@` glyph at the left of the chip,
         leaving "Image{N}" text legible to the right. The image URL
         flows in via the `--enk-ref-thumb-url` custom property. */
      const refMatch = REF_IMAGE_MENTION_RE.exec(part);
      if (refMatch) {
        const n = parseInt(refMatch[1], 10);
        const exists = n >= 1 && n <= referenceImages.length;
        const imgSrc = exists ? referenceImages[n - 1] : null;
        const refStyle = imgSrc
          ? ({
              ["--enk-ref-thumb-url" as string]: `url("${imgSrc.replace(
                /"/g,
                '\\"'
              )}")`,
            } as React.CSSProperties)
          : undefined;
        /* Bind hover only on the hit layer — that's the layer that
           already has `pointer-events: auto` on chips, and it sits
           above the visible display layer so mouse events register
           there. The display layer keeps `pointer-events: none` so
           selection / typing in the textarea below isn't blocked. */
        const refHoverHandlers =
          layer === "hit" && exists
            ? {
                onMouseEnter: (e: React.MouseEvent<HTMLSpanElement>) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setRefTooltip({
                    imageIndex: n,
                    anchor: {
                      top: rect.top,
                      bottom: rect.bottom,
                      centerX: rect.left + rect.width / 2,
                    },
                  });
                },
                onMouseLeave: () => setRefTooltip(null),
              }
            : {};
        return (
          <span
            key={`${index}-${part}-${layer}`}
            className={`enk-var-tag enk-var-tag--ref-image${
              exists ? "" : " enk-var-tag--ref-image-missing"
            }${layer === "hit" ? " enk-var-tag--hit" : ""}`}
            style={refStyle}
            {...refHoverHandlers}
          >
            {part}
          </span>
        );
      }

      if (!/^\[[^\]]*\]$/.test(part)) {
        return <Fragment key={`${index}-plain-${layer}`}>{part}</Fragment>;
      }
      const variable = variables.find((v) => v.fullToken === part);
      const isSelected = ui.selectedVariableId === variable?.id;
      const colors = variable ? getVariableColors(variable.colorIndex) : null;

      const focusVariableInPrompt = () => {
        if (!variable) return;
        const textarea = textareaRef.current;
        if (!textarea) return;
        const tokenIndex = promptData.body.indexOf(part);
        if (tokenIndex < 0) return;
        textarea.focus();
        const caret = tokenIndex + part.length;
        textarea.setSelectionRange(caret, caret);
        selectVariable(variable.id, { scrollToCard: true, cursorPos: caret, pulse: true });
      };

      const tagHandlers =
        layer === "hit"
          ? {
              role: "button" as const,
              tabIndex: -1,
              onMouseDown: (e: React.MouseEvent) => {
                e.preventDefault();
                focusVariableInPrompt();
              },
            }
          : {};

      const nameMissing = !!variable?.nameMissingHighlighted;

      return (
        <span
          key={`${index}-${part}-${layer}`}
          className={`enk-var-tag${isSelected ? " enk-var-tag--selected" : ""}${nameMissing ? " enk-var-tag--name-missing" : ""}${layer === "hit" ? " enk-var-tag--hit" : ""}`}
          {...tagHandlers}
          style={
            layer === "hit"
              ? undefined
              : colors
                ? ({
                    backgroundColor: colors.bg,
                    color: colors.text,
                    ...(isSelected ? { ["--var-tag-accent" as string]: colors.text } : {}),
                  } as React.CSSProperties)
                : undefined
          }
        >
          {part}
        </span>
      );
    });
  };

  /* ─── Preview with defaults ─── */
  const renderPreviewWithDefaults = () => {
    let previewText = promptData.body;
    variables.forEach((variable) => {
      const placeholder = `[${variable.name}]`;
      let display = "";
      if (variable.type === "text") {
        display = (variable.defaultValue as string) || "";
      } else if (variable.type === "image") {
        display = variable.description || "";
      } else if (variable.type === "checkbox") {
        display = variable.defaultValue ? variable.description : "";
      }
      previewText = previewText.split(placeholder).join(display);
    });
    return previewText;
  };

  /* ─── Update variable — syncs prompt brackets (v2: defaults vs name) ─── */
  const updateVariable = (varId: string, updates: Partial<PromptVariable>) => {
    const currentVar = variables.find((v) => v.id === varId);
    if (!currentVar) return;

    const merged: PromptVariable = { ...currentVar, ...updates };
    const isEditingName = ui.editingNameVarId === varId;
    const nextInner = getPromptTokenInner(
      { ...merged, name: isEditingName && updates.name !== undefined ? updates.name : merged.name },
      isEditingName ? varId : null
    );
    const newFullToken = buildFullToken(nextInner);

    if (newFullToken !== currentVar.fullToken) {
      setPromptData((prev) => ({
        ...prev,
        body: replaceTokenInBody(prev.body, currentVar.fullToken, newFullToken),
      }));
      setVariables((prev) =>
        prev.map((v) => (v.id === varId ? { ...merged, fullToken: newFullToken } : v))
      );
    } else {
      setVariables((prev) => prev.map((v) => (v.id === varId ? { ...v, ...updates } : v)));
    }
  };

  /* Apply a variable TYPE change with the correct, type-specific payload.
     Routing both type buttons through here keeps the text↔checkbox
     conversion in one place and prevents the "value becomes true" bug:
     when switching to checkbox we read the OLD text from
     defaultValue/description/label — never from a boolean. */
  const applyVariableTypeChange = useCallback(
    (varId: string, newType: VariableType, resetVerify: boolean) => {
      const variable = variables.find((v) => v.id === varId);
      if (!variable || variable.type === newType) return;
      if (newType === "checkbox") {
        updateVariable(varId, {
          type: "checkbox",
          description: String(
            variable.defaultValue || variable.description || variable.label
          ),
          defaultValue: true,
        });
      } else {
        updateVariable(varId, {
          type: "text",
          defaultValue:
            variable.description ||
            (typeof variable.defaultValue === "string" ? variable.defaultValue : "") ||
            variable.label,
        });
      }
      /* Changing a variable's type invalidates already-rendered verify
         images — reset them to idle so they re-generate with the new
         shape. (Only done once the user confirms.) */
      if (resetVerify) {
        setVersions((prev) =>
          prev.map((v) => ({
            ...v,
            imageUrl: null,
            status: "idle" as const,
            queuePosition: undefined,
          }))
        );
        setUi((p) => ({ ...p, selectedCards: [] }));
      }
    },
    // updateVariable intentionally omitted (stable closure over current state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [variables]
  );

  /* Entry point for the two type-toggle buttons. Guards against
     re-selecting the active type (a no-op that previously corrupted the
     value), and — if any verify card already has a generated/in-flight
     image — asks for confirmation first because those images get reset. */
  const requestVariableTypeChange = useCallback(
    (varId: string, newType: VariableType) => {
      const variable = variables.find((v) => v.id === varId);
      if (!variable || variable.type === newType) return;
      const hasVerifyWork = versions.some(
        (v) =>
          v.imageUrl ||
          v.status === "complete" ||
          v.status === "generating" ||
          v.status === "queued"
      );
      if (hasVerifyWork) {
        setUi((p) => ({ ...p, pendingTypeChange: { varId, newType } }));
        return;
      }
      applyVariableTypeChange(varId, newType, false);
    },
    [variables, versions, applyVariableTypeChange]
  );

  const handleVariableNameFocus = (varId: string) => {
    setUi((prev) => ({ ...prev, editingNameVarId: varId }));
  };

  const adoptExistingVariableName = useCallback(
    (editingVarId: string, existingVarId: string) => {
      const variable = variables.find((v) => v.id === editingVarId);
      const existing = variables.find((v) => v.id === existingVarId);
      if (!variable || !existing) return;
      const adoptToken = existing.fullToken;
      setPromptData((prev) => ({
        ...prev,
        body: replaceTokenInBody(prev.body, variable.fullToken, adoptToken),
      }));
      setVariables((prev) => prev.filter((v) => v.id !== editingVarId));
      setUi((p) => ({
        ...p,
        variableNameConflict: null,
        selectedVariableId: existingVarId,
      }));
    },
    [variables]
  );

  const createNewVariableNameFromConflict = useCallback(
    (editingVarId: string, conflictName: string) => {
      const variable = variables.find((v) => v.id === editingVarId);
      if (!variable) return;
      const newName = takeUniqueVariableLabel(
        variableLabelRegistryRef,
        conflictName,
        variables,
        promptData.body,
        editingVarId
      );
      const newToken = buildFullToken(newName);
      setPromptData((prev) => ({
        ...prev,
        body: replaceTokenInBody(prev.body, variable.fullToken, newToken),
      }));
      setVariables((prev) =>
        prev.map((v) =>
          v.id === editingVarId
            ? { ...v, name: newName, fullToken: newToken, nameBlurEmpty: false }
            : v
        )
      );
      setUi((p) => ({ ...p, variableNameConflict: null }));
    },
    [variables, promptData.body]
  );

  const confirmDeleteVariable = useCallback(
    (varId: string) => {
      const variable = variables.find((v) => v.id === varId);
      if (!variable) return;
      const replacement = getVariableReplacementText(variable);
      setPromptData((prev) => ({
        ...prev,
        body: replaceTokenInBody(prev.body, variable.fullToken, replacement),
      }));
      setVariables((prev) => prev.filter((v) => v.id !== varId));
      setUi((p) => ({
        ...p,
        variableDeleteId: null,
        selectedVariableId: p.selectedVariableId === varId ? null : p.selectedVariableId,
        variablePulsingId: p.variablePulsingId === varId ? null : p.variablePulsingId,
      }));
    },
    [variables]
  );

  const handleVariableNameBlur = (varId: string) => {
    setUi((prev) => ({ ...prev, editingNameVarId: null }));
    const variable = variables.find((v) => v.id === varId);
    if (!variable) return;

    const name = variable.name?.trim() ?? "";
    if (name) {
      const existing = findVariableByName(name, variables, varId);
      if (existing) {
        setUi((p) => ({
          ...p,
          variableNameConflict: {
            editingVarId: varId,
            conflictName: name,
            existingVarId: existing.id,
          },
        }));
        return;
      }
    }

    const nameEmpty = !name;
    setVariables((prev) =>
      prev.map((v) => (v.id === varId ? { ...v, nameBlurEmpty: nameEmpty } : v))
    );

    const inner = getPromptTokenInner(variable, null);
    const newFullToken = buildFullToken(inner);
    if (newFullToken !== variable.fullToken) {
      setPromptData((prev) => ({
        ...prev,
        body: replaceTokenInBody(prev.body, variable.fullToken, newFullToken),
      }));
      setVariables((prev) =>
        prev.map((v) =>
          v.id === varId ? { ...v, fullToken: newFullToken, nameBlurEmpty: nameEmpty } : v
        )
      );
    }
  };

  /* ─── Generate Image — uses per-card snapshot for interpolation ─── */
  const handleGenerateVersion = async (versionId: number) => {
    // Get this card's snapshot to build the prompt
    const card = versions.find(v => v.id === versionId) ??
      { variableSnapshot: {} as Record<string, string> };
    const snapshot = card.variableSnapshot;
    const cardRefs = (card as VersionCard).referenceImages ?? [];

    /* Body for the AI provider:
       1. Expand `@ImageN` mentions → "Reference image N"  (must run
          BEFORE variable substitution so the expansion isn't broken
          if a variable's value happens to contain literal "@Image").
       2. Substitute `[varName]` placeholders with their resolved
          values from the verify-card snapshot or variable defaults. */
    let previewText = expandReferenceImageMentions(promptData.body);
    variables.forEach((variable) => {
      const placeholder = `[${variable.name}]`;
      let val: string;
      if (snapshot[variable.name] !== undefined) {
        val = snapshot[variable.name];
      } else if (variable.type === "text") {
        val = (variable.defaultValue as string) || "";
      } else if (variable.type === "image") {
        val = variable.description || "";
      } else {
        val = variable.defaultValue ? variable.description : "";
      }
      previewText = previewText.split(placeholder).join(val);
    });

    // Callers queue the card before this runs, so a refusal must mark it,
    // or it spins on "generating" forever.
    const refuse = () => setVersions(prev => prev.map(v => v.id === versionId ? { ...v, status: "failed" } : v));
    if (!previewText.trim()) {
      toast({ title: "Error", description: "Please enter a prompt.", variant: "destructive" });
      refuse();
      return;
    }
    /* Routed by the selected model, never by the prompt type: "free prompt"
       is a marketplace setting, and routing on it rendered Flux for every
       chip the user picked. */
    if (!picked) {
      toast({ title: "Pick a model", description: "Choose the model to generate with. Nothing was generated.", variant: "destructive" });
      refuse();
      return;
    }
    if (!picked.free && !walletConnected) {
      setShowWalletPicker(true);
      toast({ title: "Wallet required", description: "Connect a wallet to pay for this generation.", variant: "destructive" });
      refuse();
      return;
    }
    setVersions(prev => prev.map(v => v.id === versionId ? { ...v, status: "generating" } : v));
    try {
      const outcome = await runGeneration(
        {
          model: picked,
          resolution: genResolution,
          quality,
          boost,
          prompt: previewText,
          aspectRatio: ratioForApi ?? "1:1",
          referenceImages: cardRefs.length ? cardRefs : undefined,
          authoring: true,
        },
        signPayment,
      );
      if (!outcome.ok) throw new Error(outcome.error);
      const data = outcome.data as { imageUrl: string; provider?: string; usedGemini?: boolean };
      if (!data?.imageUrl) {
        throw new Error("Image generated, but no image URL was returned.");
      }
      // Convert data URL to blob URL so browser can render large images inline
      let displayUrl = data.imageUrl;
      if (data.imageUrl.startsWith("data:")) {
        try {
          const [header, base64] = data.imageUrl.split(",");
          const mime = header.split(":")[1].split(";")[0];
          const byteChars = atob(base64);
          const bytes = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
          displayUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        } catch {
          displayUrl = data.imageUrl;
        }
      }
      setVersions(prev => prev.map(v => v.id === versionId ? { ...v, status: "complete", imageUrl: displayUrl, sourceUrl: data.imageUrl } : v));
      const userKey = getUserKeyFromAccount(account);
      if (userKey && data?.imageUrl) {
        try {
          await apiRequest("POST", "/api/generations", {
            userKey, prompt: previewText, imageUrl: String(data.imageUrl),
            provider: typeof data.provider === "string" ? data.provider : "unknown",
            meta: { usedGemini: Boolean(data.usedGemini ?? false) },
          });
        } catch { /* ignore */ }
        try {
          addCreation(userKey, {
            id: creationId(),
            imageUrl: data.imageUrl, prompt: previewText, createdAt: new Date().toISOString(),
          });
        } catch (storageError) {
          console.warn("Creation generated but could not be saved locally:", storageError);
        }
      }
      toast({ title: "Done", description: `Slot ${versionId} complete.` });
    } catch (error: unknown) {
      setVersions(prev => prev.map(v => v.id === versionId ? { ...v, status: "failed" } : v));
      const msg = error instanceof Error ? error.message : String(error);
      toast({ title: "Failed", description: msg || "Error generating.", variant: "destructive" });
    }
  };

  /* ─── Resolve variable default value by name ─── */
  const getVarDefault = (name: string): string => {
    const v = variables.find(x => x.name === name);
    if (!v) return name;
    if (v.type === "checkbox") return v.defaultValue ? "on" : "off";
    if (v.type === "image") return v.description || name;
    return (v.defaultValue as string) || name;
  };

  /* ─── Edit (back-arrow) — copy a verify card's snapshot into the
     variable defaults, then drop the card. Pulled out into a named
     helper so both call sites (clean overwrite path AND the
     "Yes, overwrite" branch of the confirm dialog) run exactly the
     same logic. */
  const applyVerifyCardToVariableDefaults = useCallback(
    (cardId: number) => {
      const card = versions.find((v) => v.id === cardId);
      if (!card) return;
      setVariables((prev) =>
        prev.map((v) =>
          card.variableSnapshot[v.name]
            ? { ...v, defaultValue: card.variableSnapshot[v.name] }
            : v
        )
      );
      setVersions((prev) => prev.filter((v) => v.id !== cardId));
      setUi((prev) => ({ ...prev, selectedCards: [] }));
    },
    [versions]
  );

  /* ─── Stack Variables — bridge button pushes N cards into Verify ─── */
  const handleStackVariables = () => {
    // Hard guard: never create Verify cards from an empty / whitespace-only
    // prompt. Mirrors the disabled state on the forward arrow button so
    // that no other code path (keyboard, programmatic) can sneak past.
    if (!hasSubstantivePromptBody(promptData.body)) return;
    const textVars = variables.filter(v => v.type === "text");
    const stackSize = Math.max(1, ...textVars.map(v => (v.values.length > 0 ? v.values.length : 1)));
    
    setVersions(prev => {
      // Remove failed cards to allow re-submission
      const activeVersions = prev.filter(v => v.status !== "failed");
      const baseId = activeVersions.length > 0 ? Math.max(...activeVersions.map(v => v.id)) : 0;
      const newCards: VersionCard[] = [];
      for (let i = 0; i < stackSize; i++) {
        const snapshot: Record<string, string> = {};
        variables.forEach(v => {
        if (v.type === "checkbox") {
          snapshot[v.name] = v.defaultValue ? v.description || "on" : "off";
        } else if (v.type === "image") {
          snapshot[v.name] = v.description || "";
        } else {
          const pool = v.values.length > 0 ? v.values : [(v.defaultValue as string) || v.name];
          snapshot[v.name] = pool[i % pool.length];
        }
      });
      newCards.push({ id: baseId + i + 1, variableSnapshot: snapshot, imageUrl: null, status: "idle" });
    }
    return [...activeVersions, ...newCards];
    });
  };

  /* ─── Batch Generate — assigns queue positions, fires sequentially ─── */
  const handleBatchGenerate = () => {
    if (!picked) {
      toast({ title: "Pick a model", description: "Choose the model to generate with.", variant: "destructive" });
      return;
    }
    const idleCards = versions.filter(v => v.status === "idle");
    if (idleCards.length === 0) {
      toast({ title: "No idle slots", description: "Stack variables first, then generate." });
      return;
    }
    const total = idleCards.length;
    // Mark all idle cards as queued with their position
    setVersions(prev => prev.map(v => {
      const pos = idleCards.findIndex(c => c.id === v.id);
      if (pos === -1) return v;
      return { ...v, status: "queued", queuePosition: pos + 1 };
    }));
    setUi(prev => ({ ...prev, queueTotal: total }));
    toast({ title: `Batch queued`, description: `${total} slot${total > 1 ? 's' : ''} queued for generation.` });
    // Fire each with stagger, clearing queue position on start
    idleCards.forEach((card, i) => {
      setTimeout(() => {
        setVersions(prev => prev.map(v => v.id === card.id ? { ...v, status: "generating", queuePosition: undefined } : v));
        handleGenerateVersion(card.id);
      }, i * 400);
    });
  };

  const handleCreateEmptySlots = () => {
    const snapshot: Record<string, string> = {};
    variables.forEach(v => { snapshot[v.name] = (v.defaultValue as string) || v.name; });
    const newId = versions.length > 0 ? Math.max(...versions.map(v => v.id)) + 1 : 1;
    setVersions(prev => [...prev, { id: newId, variableSnapshot: snapshot, imageUrl: null, status: "idle" }]);
  };

  /* ─── Per-verify-card reference images ─── */
  const MAX_VERIFY_REFS = 4;

  const addVerifyCardRef = (slotId: number, dataUrl: string) => {
    if (!dataUrl) return;
    setVersions((prev) =>
      prev.map((v) => {
        if (v.id !== slotId) return v;
        const existing = v.referenceImages ?? [];
        if (existing.length >= MAX_VERIFY_REFS) return v;
        return { ...v, referenceImages: [...existing, dataUrl] };
      })
    );
  };

  const pickVerifyCardRefs = (slotId: number) => {
    const current = versions.find((v) => v.id === slotId)?.referenceImages ?? [];
    if (current.length >= MAX_VERIFY_REFS) {
      toast({
        title: "Limit reached",
        description: `Up to ${MAX_VERIFY_REFS} reference images per render.`,
        variant: "destructive",
      });
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = (ev) => {
      const files = Array.from((ev.target as HTMLInputElement).files || []);
      files.forEach((file) => {
        const reader = new FileReader();
        reader.onload = (e) => addVerifyCardRef(slotId, String(e.target?.result || ""));
        reader.readAsDataURL(file);
      });
    };
    input.click();
  };

  const removeVerifyCardRef = (slotId: number, idx: number) => {
    setVersions((prev) =>
      prev.map((v) =>
        v.id === slotId
          ? { ...v, referenceImages: (v.referenceImages ?? []).filter((_, i) => i !== idx) }
          : v
      )
    );
  };

  /* ─── Pay & Generate — UX shows total cost, fires one paid generation per slot ─── */
  const handlePayAndGenerate = () => {
    if (!picked) {
      toast({ title: "Pick a model", description: "Choose the model to generate with.", variant: "destructive" });
      return;
    }
    if (!picked.free && !walletConnected) {
      setShowWalletPicker(true);
      toast({ title: "Wallet required", description: "Connect a wallet to pay for this generation.", variant: "destructive" });
      return;
    }
    const processableCards = versions.filter(v => v.status === "idle" || v.status === "failed");
    if (processableCards.length === 0) {
      toast({ title: "No slots ready", description: "Stack variables first." });
      return;
    }
    const cost = slotPrice(processableCards.length);
    const total = processableCards.length;
    // Mark all as queued immediately
    setVersions(prev => prev.map(v => {
      const pos = processableCards.findIndex(c => c.id === v.id);
      if (pos === -1) return v;
      return { ...v, status: "queued", queuePosition: pos + 1 };
    }));
    setUi(prev => ({ ...prev, queueTotal: total }));
    toast({
      title: `Paying ${cost} for ${total} image${total > 1 ? "s" : ""}`,
      description: "Each slot is paid separately from your wallet.",
    });
    // Fire each with 400ms stagger — each holds its own payment
    processableCards.forEach((card, i) => {
      setTimeout(() => {
        setVersions(prev => prev.map(v =>
          v.id === card.id ? { ...v, status: "generating", queuePosition: undefined } : v
        ));
        handleGenerateVersion(card.id);
      }, i * 400);
    });
  };

  /* ─── Refill & Generate — delete selected + pay 80% price for those slots ─── */
  const handleRefillAndGenerate = () => {
    if (ui.selectedCards.length === 0) return;
    if (!picked) {
      toast({ title: "Pick a model", description: "Choose the model to generate with.", variant: "destructive" });
      return;
    }
    if (!picked.free && !walletConnected) {
      setShowWalletPicker(true);
      toast({ title: "Wallet required", description: "Connect a wallet to pay for this generation.", variant: "destructive" });
      return;
    }
    const refillCount = ui.selectedCards.length;
    const cost = slotPrice(refillCount);
    // Delete selected cards
    setVersions(prev => prev.filter(v => !ui.selectedCards.includes(v.id)));
    setUi(prev => ({ ...prev, selectedCards: [] }));
    // Create fresh idle snapshots for refill slots (use current variable defaults)
    const baseSnapshot: Record<string, string> = {};
    variables.forEach(v => { baseSnapshot[v.name] = (v.defaultValue as string) || v.name; });
    const baseId = versions.filter(v => !ui.selectedCards.includes(v.id)).length > 0
      ? Math.max(...versions.filter(v => !ui.selectedCards.includes(v.id)).map(v => v.id))
      : 0;
    const refillCards: VersionCard[] = Array.from({ length: refillCount }, (_, i) => ({
      id: baseId + i + 1,
      variableSnapshot: { ...baseSnapshot },
      imageUrl: null,
      status: "queued" as const,
      queuePosition: i + 1,
    }));
    setVersions(prev => [...prev, ...refillCards]);
    setUi(prev => ({ ...prev, queueTotal: refillCount }));
    toast({
      title: `Refill pack · ${cost}`,
      description: `${refillCount} slot${refillCount > 1 ? "s" : ""} queued.`,
    });
    refillCards.forEach((card, i) => {
      setTimeout(() => {
        setVersions(prev => prev.map(v =>
          v.id === card.id ? { ...v, status: "generating", queuePosition: undefined } : v
        ));
        handleGenerateVersion(card.id);
      }, i * 400);
    });
  };


  const toggleVersionCheckbox = (id: number) => {
    setUi(prev => ({
      ...prev,
      selectedCards: prev.selectedCards.includes(id)
        ? prev.selectedCards.filter(cid => cid !== id)
        : [...prev.selectedCards, id]
    }));
  };

  /* ─── Grok auto-fill empty variables ─── */
  const handleGrokFill = async () => {
    const emptyVars = variables.filter(v => v.type === "text" && !v.defaultValue);
    if (emptyVars.length === 0) {
      // No empty vars — just create an empty slot
      handleCreateEmptySlots();
      return;
    }
    setUi(prev => ({ ...prev, isGrokFilling: true }));
    try {
      const res = await fetch("/api/grok-fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: promptData.body, variables: emptyVars.map(v => v.name) }),
      });
      const filled = await res.json() as Record<string, string>;
      setVariables(prev => prev.map(v =>
        filled[v.name] ? { ...v, defaultValue: filled[v.name] } : v
      ));
      toast({ title: "Auto filled variables", description: `Filled ${Object.keys(filled).length} variable(s).` });
    } catch {
      toast({ title: "Auto fill failed", description: "Could not auto-fill. Try again.", variant: "destructive" });
    } finally {
      setUi(prev => ({ ...prev, isGrokFilling: false }));
      handleCreateEmptySlots();
    }
  };

  /* ─── Tags ─── */
  const removeTag = (tag: string) => {
    setPromptData(prev => ({ ...prev, tags: prev.tags.filter(t => t !== tag) }));
  };

  const deleteSelectedVersions = () => {
    setVersions(prev => prev.filter(v => !ui.selectedCards.includes(v.id)));
    setUi(prev => ({ ...prev, selectedCards: [] }));
  };

  const savePromptMutation = useMutation({
    mutationFn: async (opts?: { release?: boolean }) => {
      const payload = {
        // A release lists the prompt on the server, in the same save that judges it.
        ...(opts?.release ? { release: true } : {}),
        id: ui.currentPromptId,
        title: promptData.title,
        /* Persist the canonical wording, not the editor shortcut.
           `@ImageN` is a UI affordance only; once the prompt
           leaves the editor (DB, marketplace, AI providers) it
           should always read as "Reference image N". */
        content: expandReferenceImageMentions(promptData.body),
        promptType: promptData.type,
        aiModel: models.selected[0],
        tags: promptData.tags,
        variables: variables.map((v) => {
          const n = normalizeVariable(v);
          return {
            name: n.name, label: n.label, description: n.description,
            type: n.type, defaultValue: n.defaultValue, required: n.required, position: n.position,
          };
        }),
        referenceImages,
        // Ship the completed verify-card renders as the prompt's showcase
        // images (the API stores these as uploaded_photos, which the buyer
        // generator reads as showcaseImages). Only durable URLs — blob: object
        // URLs die on reload; https (Vercel Blob) is preferred over heavy
        // base64 data: URLs. Capped so a data:-URL deployment can't bloat the
        // row. Without this the buyer gallery is always empty.
        uploadedPhotos: versions
          .filter((v) => v.status === "complete" && v.sourceUrl && !v.sourceUrl.startsWith("blob:"))
          .map((v) => v.sourceUrl as string)
          .sort((a, b) => (a.startsWith("data:") ? 1 : 0) - (b.startsWith("data:") ? 1 : 0))
          .slice(0, 4),
        price: promptData.type === "premium-prompt" ? promptPrice : 0,
      };
      // Forward the session so the server records the creator (user_id) —
      // the intent payment flow can only price prompts whose creator is
      // known. Same header the publish PATCH sends. It read Turnkey's token
      // only, which nothing writes since Turnkey was retired, so every save
      // went out anonymous and was refused.
      const response = await fetch("/api/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const savedPrompt: unknown = await response.json();
      if (!response.ok) {
        // The server's own sentence: a refusal with its warning, or "could not
        // be checked". A generic one hid both from the creator.
        const reason = (savedPrompt as { error?: unknown } | null)?.error;
        throw new Error(typeof reason === "string" && reason ? reason : "Failed to save prompt");
      }
      if (typeof savedPrompt === "object" && savedPrompt !== null && "id" in savedPrompt) {
        setUi(prev => ({ ...prev, currentPromptId: String((savedPrompt as { id?: unknown }).id ?? "") }));
      }
      return savedPrompt;
    },
    onSuccess: () => toast({ title: "Saved", description: "Prompt saved." }),
    onError: (error: unknown) => {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Save failed.", variant: "destructive" });
    },
  });

  const publishPromptMutation = useMutation({
    mutationFn: async () => {
      /* A release is a save: what is in the editor now is what goes live, and
         the server lists it only once that save has passed its checks. It used
         to save only a prompt that had no id yet and then set a publish date,
         which listed nothing; a refusal now stops the release with its reason. */
      const saved = await savePromptMutation.mutateAsync({ release: true });
      const id = typeof saved === "object" && saved !== null && "id" in saved ? String((saved as { id?: unknown }).id ?? "") : "";
      if (!id) throw new Error("Could not save prompt before publishing");
      return { id, adult: (saved as { adult?: unknown }).adult === true };
    },
    onSuccess: ({ adult }) => {
      toast({
        title: "Published",
        // The check marks a prompt 18+ by itself; said here, or the artist
        // cannot know why most visitors never see it.
        description: adult
          ? "Prompt is live. It was marked 18+ and is shown only to viewers who may see 18+ content."
          : "Prompt is now live on the marketplace.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/prompts"] });
      /* A release ends the draft. Left in place it came back on the next
         visit still tied to the live prompt, with nothing saying so: the next
         prompt written over it replaced the listing for good. The state is
         reset too, not only the storage, or a pending autosave writes the
         released prompt back before the editor is left. */
      resetEditor();
      router.push("/showcase");
    },
    onError: (error: unknown) => {
      console.error("Publish failed:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Publish failed.",
        variant: "destructive",
      });
    },
  });

  const verifiedCount = versions.filter((s) => s.imageUrl && s.status === "complete").length;
  const isPublishDisabled = verifiedCount === 0 || publishPromptMutation.isPending;
  /* Forward-arrow gate: prompt body must contain at least one real
     non-whitespace character (and not be just an empty `[bracket]`)
     before the user can push to Verify. */
  const hasPromptBody = hasSubstantivePromptBody(promptData.body);
  const allVariablesFilled =
    variables.length === 0 ||
    variables.every((v) => v.type === "checkbox" || v.defaultValue);
  const canPushToVerify = hasPromptBody && allVariablesFilled;

  /* ─── Dice (🎲 next to Pay & Gen) ───
     PromptVariable.id is the stable key the rolled values come back under.
     Unnamed variables are skipped because the API rejects name: "" — and an
     unnamed variable's prompt token embeds its defaultValue, so writing to it
     behind updateVariable's back would desync the body. Image variables pass
     through untouched; the shared dice filters them out itself. */
  const diceVariables: DiceVariable[] = variables
    .filter((v) => v.name.trim())
    .map((v) => ({
      id: v.id,
      name: v.name,
      label: v.label || undefined,
      description: v.description || undefined,
      type: v.type,
    }));

  const applyDiceValues = (values: Record<string, DiceValue>) => {
    setVariables((prev) =>
      prev.map((v) => {
        const val = values[v.id];
        // defaultValue only, like Auto Fill and the card input — a roll must
        // not wipe a hand-built batch stack (`values`). Named variables keep
        // their `[name]` token, so no body rewrite is needed.
        if (v.type === "checkbox" && typeof val === "boolean") return { ...v, defaultValue: val };
        if (v.type === "text" && typeof val === "string") return { ...v, defaultValue: val };
        return v;
      })
    );
  };


  const settingsPristine =
    !promptData.title.trim() &&
    promptData.tags.length === 0 &&
    models.selected.length === 0;

  const settingsMissing = {
    title: !promptData.title.trim(),
    category: promptData.tags.length === 0,
    models: models.selected.length === 0,
    price:
      promptData.type === "premium-prompt" &&
      (!promptPrice || promptPrice <= 0 || (settingsPristine && !ui.pricePerRenderReviewed)),
  };

  const hasSettingsErrors = Object.values(settingsMissing).some(Boolean);

  /** Red on rail icons only while collapsed */
  const railFieldError = (key: keyof typeof settingsMissing) =>
    ui.settingsCollapsed && settingsMissing[key];

  /** Red on inputs only after Release click while expanded */
  const fieldError = (key: keyof typeof settingsMissing) =>
    !ui.settingsCollapsed && ui.settingsReleaseAttempted && settingsMissing[key];

  const handleReleaseClick = () => {
    // The desktop button is disabled by these two; the mobile sheet has its
    // own button, so the rule is asked here, where every release starts.
    if (publishPromptMutation.isPending) return;
    if (verifiedCount === 0) {
      toast({ title: "No image yet", description: "Generate at least one image from this prompt before releasing it.", variant: "destructive" });
      return;
    }
    if (hasSettingsErrors) {
      setUi((prev) => ({ ...prev, settingsReleaseAttempted: true }));
      toast({
        title: "Settings incomplete",
        description: ui.settingsCollapsed
          ? "Open settings (gear) and fill the highlighted fields."
          : "Fill all highlighted fields before releasing.",
        variant: "destructive",
      });
      return;
    }
    publishPromptMutation.mutate();
  };

  const setSettingsSectionRef = useCallback(
    (section: SettingsSectionId) => (el: HTMLDivElement | null) => {
      if (el) settingsSectionRefs.current[section] = el;
      else delete settingsSectionRefs.current[section];
    },
    []
  );

  const handleRailSectionClick = useCallback(
    (e: React.MouseEvent, section: SettingsSectionId, options?: { pulse?: boolean }) => {
      e.stopPropagation();
      e.preventDefault();
      setUi((p) => {
        settingsExpandDelayRef.current = p.settingsCollapsed ? 300 : 0;
        return {
          ...p,
          settingsCollapsed: false,
          settingsPendingSection: section,
          settingsPulseOnNavigate: options?.pulse !== false,
        };
      });
    },
    []
  );

  const expandSettings = useCallback(() => {
    setUi((p) => ({
      ...p,
      settingsCollapsed: false,
      settingsPendingSection: null,
      settingsHighlightSection: null,
    }));
  }, []);

  const settingsSectionClass = useCallback(
    (section: SettingsSectionId, needsInput?: boolean) => {
      const base = "enk-settings-section";
      if (ui.settingsHighlightSection !== section) return base;
      return `${base} ${needsInput ? "enk-settings-section--pulse-missing" : "enk-settings-section--pulse"}`;
    },
    [ui.settingsHighlightSection]
  );

  useEffect(() => {
    if (ui.settingsCollapsed || !ui.settingsPendingSection) return;

    const section = ui.settingsPendingSection;
    const shouldPulse = ui.settingsPulseOnNavigate;
    const expandDelay = settingsExpandDelayRef.current;
    settingsExpandDelayRef.current = 0;
    let cancelled = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let startTimer: ReturnType<typeof setTimeout> | null = null;

    const finishScroll = (el: HTMLElement, body: HTMLDivElement) => {
      body.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: "auto" });
      setUi((p) => {
        if (p.settingsPendingSection !== section) return p;
        return {
          ...p,
          settingsPendingSection: null,
          settingsHighlightSection: shouldPulse ? section : null,
        };
      });
      if (settingsHighlightTimerRef.current) clearTimeout(settingsHighlightTimerRef.current);
      if (shouldPulse) {
        settingsHighlightTimerRef.current = setTimeout(() => {
          setUi((p) => ({ ...p, settingsHighlightSection: null }));
        }, 2000);
      }
    };

    const tryScroll = () => {
      if (cancelled) return;
      const body = settingsBodyRef.current;
      const el = settingsSectionRefs.current[section];

      if (!body || body.clientWidth < 40) {
        attempts += 1;
        if (attempts < 30) retryTimer = setTimeout(tryScroll, 50);
        return;
      }

      if (el) {
        finishScroll(el, body);
        return;
      }

      attempts += 1;
      if (attempts < 30) retryTimer = setTimeout(tryScroll, 50);
    };

    startTimer = setTimeout(tryScroll, expandDelay);

    return () => {
      cancelled = true;
      if (startTimer) clearTimeout(startTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [ui.settingsCollapsed, ui.settingsPendingSection, ui.settingsPulseOnNavigate]);

  useEffect(() => {
    return () => {
      if (settingsHighlightTimerRef.current) clearTimeout(settingsHighlightTimerRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (variablePulseTimerRef.current) clearTimeout(variablePulseTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const varId = pendingVarScrollRef.current;
    if (!varId) return;
    scrollVariableCardIntoView(varId);
    pendingVarScrollRef.current = null;
  }, [variables, scrollVariableCardIntoView]);

  return (
    <>
      <AlertDialog
        open={ui.variableDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setUi((p) => ({ ...p, variableDeleteId: null }));
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete variable</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const target = variables.find((v) => v.id === ui.variableDeleteId);
                const label = target ? getVariableDeleteLabel(target) : "this variable";
                return `Are you sure you want to delete the variable '${label}'?`;
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (ui.variableDeleteId) confirmDeleteVariable(ui.variableDeleteId);
              }}
            >
              Yes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* "Overwrite variable defaults?" — replaces the old
          `window.confirm(...)` that used to fire when the back-arrow
          tried to copy a verify-card snapshot over existing defaults.
          Same shape as the "Delete variable" dialog above (single
          Yes/No pair) so the two destructive confirmations feel
          consistent to the user. */}
      <AlertDialog
        open={ui.editOverwriteConfirmCardId !== null}
        onOpenChange={(open) => {
          if (!open)
            setUi((p) => ({ ...p, editOverwriteConfirmCardId: null }));
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Overwrite variable defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace your current variable defaults with the
              values from the selected card.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const cardId = ui.editOverwriteConfirmCardId;
                setUi((p) => ({ ...p, editOverwriteConfirmCardId: null }));
                if (cardId !== null) {
                  applyVerifyCardToVariableDefaults(cardId);
                }
              }}
            >
              Yes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={ui.confirmNewOpen}
        onOpenChange={(open) => {
          if (!open) setUi((p) => ({ ...p, confirmNewOpen: false }));
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a new prompt?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears the prompt, variables, settings, reference images and
              all verify cards, and forgets the saved draft. This can&apos;t be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleNewPrompt}>
              Yes, clear everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={ui.pendingVarSync}
        onOpenChange={(open) => {
          if (open) return;
          // Closing without confirming ("No" / Esc) → undo the new
          // variable entirely; nothing is added and the images stay.
          if (!varSyncConfirmingRef.current) {
            revertNewVariables(pendingNewVarIdsRef.current);
          }
          pendingNewVarIdsRef.current = [];
          varSyncConfirmingRef.current = false;
          setUi((p) => ({ ...p, pendingVarSync: false }));
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              Changes to your variables mean the images have to be made again.
              Are you sure you want to add this variable?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                varSyncConfirmingRef.current = true;
                applyVarSyncToVersions(true);
                syncedVarIdsRef.current = new Set(variables.map((v) => v.id));
                pendingNewVarIdsRef.current = [];
              }}
            >
              Yes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={ui.pendingTypeChange !== null}
        onOpenChange={(open) => {
          if (!open) setUi((p) => ({ ...p, pendingTypeChange: null }));
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              Changes to your variables mean the images have to be made again.
              Are you sure you want to change this variable&apos;s type?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const pending = ui.pendingTypeChange;
                setUi((p) => ({ ...p, pendingTypeChange: null }));
                if (pending) {
                  applyVariableTypeChange(pending.varId, pending.newType, true);
                }
              }}
            >
              Yes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={ui.variableNameConflict !== null}
        onOpenChange={(open) => {
          if (!open) setUi((p) => ({ ...p, variableNameConflict: null }));
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Variable name already exists</AlertDialogTitle>
            <AlertDialogDescription>
              {ui.variableNameConflict
                ? `Variable "${ui.variableNameConflict.conflictName}" already exists. Adopt that variable's token in your prompt, or create a new unique name.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-row sm:justify-end sm:gap-2">
            <AlertDialogCancel
              onClick={() => {
                const c = ui.variableNameConflict;
                if (c) createNewVariableNameFromConflict(c.editingVarId, c.conflictName);
              }}
            >
              Create new name
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const c = ui.variableNameConflict;
                if (c) adoptExistingVariableName(c.editingVarId, c.existingVarId);
              }}
            >
              {ui.variableNameConflict
                ? `Adopt "${ui.variableNameConflict.conflictName}"`
                : "Adopt variable"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* "Variable names required" alert — fired by the forward-arrow
          click handler when at least one variable still has an empty
          name. The dialog deliberately has a different shape than the
          other (Yes/No) confirmation dialogs in this file:
            • Single visual focus point: a soft-orange warning badge
              with an alert glyph at the top, centered.
            • Title is the only on-screen prose (verbatim per design
              request) — centered to read like a clean callout.
            • One full-width primary action ("Ok") centered in the
              footer, no Cancel because there's nothing to cancel.
          Description is rendered as `sr-only` so screen readers still
          get a sentence (Radix would warn otherwise). */}
      <AlertDialog
        open={ui.variableNameMissingAlertOpen}
        onOpenChange={(open) => {
          if (!open)
            setUi((p) => ({ ...p, variableNameMissingAlertOpen: false }));
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader className="items-center sm:text-center">
            <div
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-full"
              style={{
                background: "rgba(199, 102, 58, 0.14)",
              }}
            >
              <AlertTriangle size={26} color="#c7663a" strokeWidth={2.25} />
            </div>
            <AlertDialogTitle className="text-center text-xl font-semibold leading-snug">
              Please set up all variable names first!
            </AlertDialogTitle>
            <AlertDialogDescription className="sr-only">
              One or more variables have no name yet. Press Ok to highlight them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:justify-center">
            <AlertDialogAction
              className="min-w-[140px]"
              onClick={() => {
                setVariables((prev) =>
                  prev.map((v) =>
                    !v.name.trim()
                      ? { ...v, nameMissingHighlighted: true }
                      : v
                  )
                );
                setUi((p) => ({
                  ...p,
                  variableNameMissingAlertOpen: false,
                }));
              }}
            >
              Ok
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    <div className="enk-page" onClick={() => { setUi(prev => ({ ...prev, showAvatarDropdown: false, tooltip: null })) }}>
      <WalletPickerModal open={showWalletPicker} onClose={() => setShowWalletPicker(false)} />

      {/* ═══ 4-COLUMN GRID ═══ */}
      <div className={`enk-grid desktop-only ${ui.settingsCollapsed ? "enk-grid--settings-collapsed" : ""}`}>

        {/* ═══ PANEL 01 — Settings ═══ */}
        <section className={`enk-panel enk-panel--settings ${ui.settingsCollapsed ? "enk-panel--settings-collapsed" : ""}`}>
          <div className={`enk-panel__header enk-panel__header--settings ${ui.settingsCollapsed ? "enk-panel__header--settings-collapsed" : ""}`}>
            <div className="enk-settings-header__left">
              <span className="enk-panel__number">01</span>
              {ui.settingsCollapsed ? (
                <button
                  type="button"
                  className={`enk-settings-gear-btn ${hasSettingsErrors ? "enk-settings-gear-btn--alert" : ""}`}
                  aria-label="Open settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    expandSettings();
                  }}
                >
                  <Settings size={16} />
                </button>
              ) : (
                <span className="enk-panel__title">Settings</span>
              )}
            </div>
            {!ui.settingsCollapsed && (
              <button
                type="button"
                className="enk-settings-collapse-btn"
                aria-label="Collapse settings"
                onClick={(e) => {
                  e.stopPropagation();
                  setUi((p) => ({ ...p, settingsCollapsed: true }));
                }}
              >
                <ChevronLeft size={16} />
              </button>
            )}
          </div>
          <div className="enk-settings-rail">
              <button type="button" className={`enk-settings-rail__btn ${railFieldError("title") ? "enk-field--missing" : ""}`} title="Prompt title" onClick={(e) => handleRailSectionClick(e, "title")}><Type size={16} /></button>
              <button type="button" className={`enk-settings-rail__btn ${railFieldError("category") ? "enk-field--missing" : ""}`} title="Category" onClick={(e) => handleRailSectionClick(e, "category")}><Tags size={16} /></button>
              <button type="button" className={`enk-settings-rail__btn ${railFieldError("models") ? "enk-field--missing" : ""}`} title="Models" onClick={(e) => handleRailSectionClick(e, "models")}><Cpu size={16} /></button>
              <button type="button" className="enk-settings-rail__btn" title="Ratio" onClick={(e) => handleRailSectionClick(e, "ratio", { pulse: false })}><Ratio size={16} /></button>
              <button type="button" className="enk-settings-rail__btn" title="Reference images" onClick={(e) => handleRailSectionClick(e, "references", { pulse: false })}><ImageIcon size={16} /></button>
              <button type="button" className={`enk-settings-rail__btn ${railFieldError("price") ? "enk-field--missing" : ""}`} title="Price per render" onClick={(e) => handleRailSectionClick(e, "price")}><DollarSign size={16} /></button>
          </div>
          <div
            ref={settingsBodyRef}
            className="enk-panel__body"
            aria-hidden={ui.settingsCollapsed}
          >
            <div ref={setSettingsSectionRef("title")} className={settingsSectionClass("title", settingsMissing.title)}>
            <div className="enk-label" style={{ marginTop: 0 }}>PROMPT TITLE</div>
            <input
              className={`enk-input enk-input--title ${fieldError("title") ? "enk-field--missing" : ""}`}
              value={promptData.title}
              onChange={(e) => setPromptData(prev => ({ ...prev, title: e.target.value }))}
              placeholder="Untitled Prompt"
            />
            </div>

            {/* Display Mode */}
            <div className="enk-label">DISPLAY MODE</div>
            <div
              className={`enk-mode-card ${promptData.type === "free-prompt" ? "enk-mode-card--active" : ""}`}
              onClick={() => setPromptData(prev => ({ ...prev, type: "free-prompt" }))}
            >
              <div className="enk-mode-card__title">Free prompt</div>
              <div className="enk-mode-card__desc">Open the full prompt · anyone can copy & remix it</div>
            </div>
            <div
              className={`enk-mode-card ${promptData.type === "premium-prompt" ? "enk-mode-card--active" : ""}`}
              onClick={() => {
                setPromptData((prev) => ({ ...prev, type: "premium-prompt" }));
                setUi((p) => ({ ...p, pricePerRenderReviewed: false }));
              }}
            >
              <div className="enk-mode-card__title">Premium prompt</div>
              <div className="enk-mode-card__desc">Body locked · buyer fills variables and pays per render</div>
            </div>

            <div className="enk-divider" />

            <div ref={setSettingsSectionRef("category")} className={settingsSectionClass("category", settingsMissing.category)}>
            <div className="enk-label">CATEGORY</div>
            <div className={`enk-tag-input-wrap ${fieldError("category") ? "enk-field--missing" : ""}`}>
              <div className="enk-tag-chips">
                {promptData.tags.map(tag => (
                  <span key={tag} className="enk-tag-chip">
                    {tag}
                    <button className="enk-tag-chip__remove" onClick={() => removeTag(tag)}>×</button>
                  </span>
                ))}
              </div>
              {/* Category is picked from the same set of categories shown as
                  filters on the main feed page (ENKI_CATEGORIES). Single-select:
                  picking a category replaces the current one; picking the active
                  one clears it. */}
              <Popover open={catOpen} onOpenChange={setCatOpen}>
                <PopoverTrigger asChild>
                  <button type="button" className="enk-category-select">
                    <span className="enk-category-select__label">
                      {promptData.tags.length ? "Change category" : "Select a category"}
                    </span>
                    <ChevronDown size={14} strokeWidth={2} />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  side="bottom"
                  className="enk-category-popover z-[120] w-[var(--radix-popover-trigger-width)] min-w-[180px] border-[var(--enk-border)] bg-[var(--enk-panel)] p-1 text-[var(--enk-text)] shadow-lg"
                >
                  {ENKI_CATEGORIES.map((label) => {
                    const selected = promptData.tags.includes(label.toLowerCase());
                    return (
                      <button
                        key={label}
                        type="button"
                        className={`enk-category-option ${selected ? "enk-category-option--active" : ""}`}
                        onClick={() => {
                          setPromptData((prev) => ({
                            ...prev,
                            tags: selected ? [] : [label.toLowerCase()],
                          }));
                          setCatOpen(false);
                        }}
                      >
                        <span>{label}</span>
                        {selected && <Check size={14} strokeWidth={2.5} />}
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            </div>
            </div>

            <div className="enk-divider" />

            <div ref={setSettingsSectionRef("models")} className={settingsSectionClass("models", settingsMissing.models)}>
            <div className="enk-label">
              <span>MODEL</span>
            </div>
            <div className={fieldError("models") ? "enk-field--missing-block" : undefined}>
            {models.available.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--enk-muted)" }}>No models available</div>
            ) : (
              models.available.map((model) => {
                const isActive = models.selected.includes(model.id);
                return (
                  <div
                    key={model.id}
                    className={`enk-model-card ${isActive ? "enk-model-card--active" : ""}`}
                    onClick={() => toggleModel(model.id)}
                  >
                    <span className="enk-model-card__name">
                      {model.name}
                    </span>
                    <span className="enk-model-card__price">{modelPriceLabel(model.id) ?? "—"}</span>
                  </div>
                );
              })
            )}
            </div>
            </div>

            <div className="enk-divider" />

            <div ref={setSettingsSectionRef("ratio")} className={settingsSectionClass("ratio", false)}>
            <div className="enk-label">PREFERRED RATIO</div>
            <div className="enk-ratio-group">
              {offeredRatios.map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    className={`enk-ratio-pill ${ratios.selected === ratio ? "enk-ratio-pill--active" : ""}`}
                    onClick={() => setRatios(prev => ({ ...prev, selected: ratio }))}
                  >
                    {ratio}
                  </button>
              ))}
            </div>
            <p className="enk-hint-text">Buyer picks the ratio at render time.</p>
            </div>

            <div className="enk-divider" />

            {/* Boost — same model, priority host, faster. Sits with the other
                generation settings rather than beside the button, because it
                changes what the generation IS, not just when it starts. */}
            <div className="enk-label">SPEED</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <BoostToggle boost={boost} onChange={setBoost} available={!!picked?.boostAvailable} />
              <QualitySelect
                value={quality}
                onChange={setQuality}
                available={!!picked?.supportsQuality}
              />
              <p className="enk-hint-text" style={{ margin: 0 }}>
                {boost
                  ? "Priority provider · about 3x faster · priced at the vendor's own rate"
                  : "Standard queue. Turn on Boost for a priority provider."}
              </p>
            </div>

            <div className="enk-divider" />

            <div ref={setSettingsSectionRef("references")} className={settingsSectionClass("references", false)}>
            <div className="enk-label">
              <span>REFERENCE IMAGES</span>
            </div>

            {/* Prompt-relevant reference images — the prompt author's
                own example images, attached to the prompt itself.
                Lives here in Settings (not in the Variables panel)
                because the data is part of the prompt definition,
                not a per-render input the buyer chooses. */}
            <div className="enk-settings-box">
              <div className="enk-label" style={{ marginTop: 0 }}>PROMPT RELEVANT REFERENCE IMAGES</div>
              <div
                className={`enk-ref-zone${externalDragActive ? " enk-ref-zone--drop-active" : ""}`}
                onDragEnter={handleRefZoneDragEnter}
                onDragLeave={handleRefZoneDragLeave}
                onDragOver={handleRefZoneDragOver}
                onDrop={handleRefZoneDrop}
              >
                <div className="enk-ref-row">
                  <button
                    type="button"
                    className="enk-ref-add"
                    aria-label="Add reference images"
                    title="Click or drag images here for reference"
                    disabled={referenceImages.length >= ui.maxImages}
                    onClick={(e) => {
                      e.stopPropagation();
                      pickReferenceImages();
                    }}
                  >
                    <Plus size={16} />
                  </button>
                  {referenceImages.length === 0 && (
                    <span
                      className={`enk-ref-hint${externalDragActive ? " enk-ref-hint--drop" : ""}`}
                    >
                      {externalDragActive
                        ? "Drop here to add as image #1"
                        : "Click or drag images here for reference"}
                    </span>
                  )}
                  {referenceImages.length > 0 && (
                    /* Cascading card-stack — each slot overlaps the
                       previous one by a fixed offset (see CSS for the
                       `--enk-ref-overlap` math). Hovering or focusing a
                       slot lifts it via z-index so its remove button
                       stays reachable even when buried under others. */
                    <div className="enk-ref-stack">
                      {referenceImages.map((src, idx) => {
                        const isDragging = refImageDrag.from === idx;
                        const isDropTarget =
                          refImageDrag.from !== null &&
                          refImageDrag.over === idx &&
                          refImageDrag.from !== idx;
                        return (
                          <div
                            key={`${idx}-${src.slice(0, 32)}`}
                            className={`enk-ref-slot${isDragging ? " enk-ref-slot--dragging" : ""}${isDropTarget ? " enk-ref-slot--drop-target" : ""}`}
                            draggable
                            role="button"
                            tabIndex={0}
                            aria-label={`Open reference image ${idx + 1}`}
                            onClick={(e) => {
                              /* HTML5 DnD suppresses the trailing
                                 click after a real drag, so this
                                 only fires for plain mouse-clicks
                                 (and keyboard activation below). */
                              e.stopPropagation();
                              setRefPreviewDirection("init");
                              setRefPreviewIndex(idx);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setRefPreviewDirection("init");
                                setRefPreviewIndex(idx);
                              }
                            }}
                            onDragStart={(e) => {
                              setRefImageDrag({ from: idx, over: idx });
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", String(idx));
                            }}
                            onDragEnd={() => setRefImageDrag({ from: null, over: null })}
                            onDragOver={(e) => {
                              if (refImageDrag.from === null) return;
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = "move";
                              setRefImageDrag((d) =>
                                d.from !== null && d.over !== idx ? { ...d, over: idx } : d
                              );
                            }}
                            onDrop={(e) => {
                              if (refImageDrag.from === null) return;
                              e.preventDefault();
                              e.stopPropagation();
                              const from = Number.parseInt(e.dataTransfer.getData("text/plain"), 10);
                              if (!Number.isNaN(from)) reorderReferenceImages(from, idx);
                              setRefImageDrag({ from: null, over: null });
                            }}
                          >
                            <img src={src} alt={`Reference ${idx + 1}`} draggable={false} />
                            {/* Ordinal. Not decoration: the prompt body
                                binds reference images by position
                                (`@Image3` resolves to referenceImages[2],
                                see REF_IMAGE_MENTION_RE), and the deck
                                showed no numbers at all, so the author had
                                to count overlapping thumbnails to find the
                                one they meant. aria-hidden because the slot
                                already announces its index. */}
                            <span className="enk-ref-slot__num" aria-hidden="true">
                              {idx + 1}
                            </span>
                            <button
                              type="button"
                              className="enk-ref-slot__remove"
                              aria-label="Remove reference image"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                setReferenceImages((prev) => prev.filter((_, i) => i !== idx));
                              }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {/* Drop-position enumeration — only rendered while a
                    drag is actually happening (external file drag OR
                    internal reorder). Sits at the bottom of the zone
                    so it never affects the row's resting height. */}
                {(externalDragActive || refImageDrag.from !== null) && (
                  <div className="enk-ref-zone__meta">
                    {externalDragActive
                      ? `Drop here to add as image #${referenceImages.length + 1}`
                      : refImageDrag.over !== null
                        ? `Move to position #${refImageDrag.over + 1}`
                        : ""}
                  </div>
                )}
              </div>
            </div>

            {/* MAX USER IMAGES — separate concern from the author's
                reference images above. Controls how many images each
                BUYER may upload at render time, hence the rename. */}
            <div className="enk-settings-box" style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
                <span style={{ fontSize: 9, fontFamily: "var(--enk-font-mono)", color: "var(--enk-hint)", letterSpacing: "0.05em" }}>MAX USER IMAGES</span>
                {/* Same molded-stepper + per-digit roll animation
                    pattern as the price input, scaled down for the
                    integer 1..10 range. The − and + buttons share a
                    single rounded container with one shared
                    horizontal divider; the value rolls via a keyed
                    span only on button-driven changes. */}
                {(() => {
                  const valueStr = String(ui.maxImages);
                  const prevStr = maxImagesRollDir
                    ? String(prevMaxImagesRollSnapshotRef.current)
                    : valueStr;
                  let diffIdx = valueStr.length;
                  const minLen = Math.min(valueStr.length, prevStr.length);
                  for (let i = 0; i < minLen; i++) {
                    if (valueStr[i] !== prevStr[i]) {
                      diffIdx = i;
                      break;
                    }
                  }
                  if (
                    valueStr.length !== prevStr.length &&
                    diffIdx === valueStr.length
                  ) {
                    diffIdx = minLen;
                  }
                  const stable = valueStr.substring(0, diffIdx);
                  const changing = valueStr.substring(diffIdx);
                  return (
                    <div className="enk-int-stepper">
                      <button
                        type="button"
                        className="enk-int-stepper__btn"
                        aria-label="Decrease max user images"
                        onClick={() => handleMaxImagesStep(-1)}
                      >
                        −
                      </button>
                      <span
                        className="enk-int-stepper__value"
                        aria-live="polite"
                      >
                        {stable && (
                          <span className="enk-int-stepper__digits-stable">
                            {stable}
                          </span>
                        )}
                        {changing && (
                          <span
                            key={
                              maxImagesRollDir
                                ? `roll-${maxImagesRollKeyRef.current}`
                                : `stable-${changing}`
                            }
                            className={`enk-int-stepper__digits-changing${
                              maxImagesRollDir
                                ? ` enk-int-stepper__digits-changing--${maxImagesRollDir}`
                                : ""
                            }`}
                          >
                            {changing}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="enk-int-stepper__btn"
                        aria-label="Increase max user images"
                        onClick={() => handleMaxImagesStep(1)}
                      >
                        +
                      </button>
                    </div>
                  );
                })()}
              </div>
              <p className="enk-hint-text" style={{ margin: 0 }}>
                Buyers can upload an image — or pick an NFT from their wallet — up to {ui.maxImages} per render.
              </p>
            </div>
            </div>

            <div className="enk-divider" style={{ marginTop: 24, marginBottom: 24 }} />

            <div ref={setSettingsSectionRef("price")} className={settingsSectionClass("price", settingsMissing.price)}>
            <div className="enk-label">PRICING</div>
            {promptData.type === "premium-prompt" ? (
              <div className={`enk-settings-box ${fieldError("price") ? "enk-field--missing" : ""}`}>
                <div className="enk-label" style={{ marginTop: 0 }}>PRICE PER RENDER (USDC)</div>
                {/* Custom number input.
                    Architecture:
                      - The wrapping `__field-wrap` carries the
                        bottom-border underline, NOT the <input>.
                        That way the underline never moves when the
                        roll animation plays — only the digits do.
                      - The real <input> is rendered with TRANSPARENT
                        text + a visible caret; it receives clicks
                        and keyboard input, but doesn't draw glyphs.
                      - The visual layer ABOVE the input renders the
                        formatted value as two spans: a stable
                        prefix (digits that didn't change) and an
                        animated suffix (digits that did). Only the
                        suffix gets the slide-in keyframe — exactly
                        the slot-machine effect the user requested.
                      - When the user FOCUSES the field to type, the
                        visual layer hides and the input's text
                        becomes opaque so they can see what they're
                        editing.
                    Buttons are stacked vertically inside a single
                    rounded container with one shared inner divider
                    so the seam between ▲ and ▼ reads as molded. */}
                {(() => {
                  const formatPrice = (n: number) =>
                    !n
                      ? ""
                      : n.toLocaleString(undefined, {
                          minimumFractionDigits: 4,
                          maximumFractionDigits: 4,
                        });
                  const valueStr = formatPrice(promptPrice || 0);
                  const prevStr = priceRollDir
                    ? formatPrice(prevPriceRollSnapshotRef.current || 0)
                    : valueStr;
                  let diffIdx = valueStr.length;
                  const minLen = Math.min(valueStr.length, prevStr.length);
                  for (let i = 0; i < minLen; i++) {
                    if (valueStr[i] !== prevStr[i]) {
                      diffIdx = i;
                      break;
                    }
                  }
                  if (
                    valueStr.length !== prevStr.length &&
                    diffIdx === valueStr.length
                  ) {
                    diffIdx = minLen;
                  }
                  const stable = valueStr.substring(0, diffIdx);
                  const changing = valueStr.substring(diffIdx);
                  return (
                    <div
                      className="enk-num-input"
                      style={{ marginTop: 8 }}
                    >
                      <div className="enk-num-input__field-wrap">
                        <input
                          type="text"
                          inputMode="decimal"
                          className="enk-input enk-num-input__field"
                          style={{ fontSize: 14 }}
                          value={priceText}
                          onChange={(e) => {
                            // Allow only digits and a single decimal point so
                            // "0", "0.", and "0.05" can all be typed freely.
                            // Treat a typed comma as a decimal point.
                            let raw = e.target.value
                              .replace(/,/g, ".")
                              .replace(/[^0-9.]/g, "");
                            const firstDot = raw.indexOf(".");
                            if (firstDot !== -1) {
                              raw =
                                raw.slice(0, firstDot + 1) +
                                raw.slice(firstDot + 1).replace(/\./g, "");
                            }
                            setPriceText(raw);
                            const n = parseFloat(raw);
                            setPromptPrice(Number.isFinite(n) ? n : 0);
                            setUi((p) => ({ ...p, pricePerRenderReviewed: true }));
                          }}
                          onFocus={() =>
                            setUi((p) => ({ ...p, pricePerRenderReviewed: true }))
                          }
                        />
                        <div
                          className="enk-num-input__visual"
                          aria-hidden="true"
                        >
                          {valueStr === "" ? (
                            <span className="enk-num-input__placeholder">
                              0.0000
                            </span>
                          ) : (
                            <>
                              {stable && (
                                <span className="enk-num-input__digits-stable">
                                  {stable}
                                </span>
                              )}
                              {changing && (
                                <span
                                  key={
                                    priceRollDir
                                      ? `roll-${priceRollKeyRef.current}`
                                      : `stable-${changing}`
                                  }
                                  className={`enk-num-input__digits-changing${
                                    priceRollDir
                                      ? ` enk-num-input__digits-changing--${priceRollDir}`
                                      : ""
                                  }`}
                                >
                                  {changing}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="enk-num-input__buttons" aria-hidden="true">
                        <button
                          type="button"
                          className="enk-num-input__btn"
                          aria-label="Increase price"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => handlePriceStep(0.0001)}
                        >
                          <ChevronUp size={12} strokeWidth={2.5} />
                        </button>
                        <button
                          type="button"
                          className="enk-num-input__btn"
                          aria-label="Decrease price"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => handlePriceStep(-0.0001)}
                        >
                          <ChevronDown size={12} strokeWidth={2.5} />
                        </button>
                      </div>
                    </div>
                  );
                })()}
                <p className="enk-hint-text" style={{ margin: "8px 0 0" }}>
                  Buyers pay this amount each time they run your premium prompt.
                </p>
              </div>
            ) : (
              <div className="enk-settings-box">
                <p className="enk-hint-text" style={{ margin: 0, fontSize: 11, color: "var(--enk-muted)" }}>
                  Free prompts cost nothing to use.<br />Buyers run the prompt with their own API credits.
                </p>
              </div>
            )}
            </div>
            <div style={{ height: 24, flexShrink: 0 }} />
          </div>
        </section>

        {/* ═══ PANEL 02 — Prompt ═══ */}
        <section className="enk-panel enk-panel--prompt">
          <div className="enk-panel__header">
            <div style={{ display: "flex", alignItems: "baseline" }}>
              <span className="enk-panel__number">02</span>
              <span className="enk-panel__title">Prompt</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {/* Clear — wipes everything and starts fresh. Sits left of Undo. */}
              <button
                type="button"
                className="enk-prompt-new-btn"
                onClick={() => setUi((p) => ({ ...p, confirmNewOpen: true }))}
                title="Clear everything and start fresh"
              >
                <Eraser size={13} />
                Clear
              </button>
              {/* Undo / Redo — icon-only, mirror Ctrl+Z / Ctrl+Y. */}
              <button
                type="button"
                className="enk-prompt-history-btn"
                onClick={handleUndo}
                disabled={!canUndo}
                aria-label="Undo"
                title={canUndo ? "Undo (Ctrl+Z)" : "Nothing to undo"}
              >
                <Undo2 size={13} />
              </button>
              <button
                type="button"
                className="enk-prompt-history-btn"
                onClick={handleRedo}
                disabled={!canRedo}
                aria-label="Redo"
                title={canRedo ? "Redo (Ctrl+Y)" : "Nothing to redo"}
              >
                <Redo2 size={13} />
              </button>
              <button className="enk-btn enk-btn--ghost enk-btn--sm" onClick={handleVariableButtonClick}>
                <Plus size={14} /> Variable
              </button>
            </div>
          </div>
          <div className="enk-panel__body enk-panel__body--workspace">
            {/* Tooltip */}
            {ui.tooltip && (
              <div
                className="enk-tooltip"
                style={{ left: ui.tooltip.x, top: ui.tooltip.y }}
                onClick={(e) => { e.stopPropagation(); createVariableFromSelection(); }}
              >
                <Plus size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} /> Create Variable
              </div>
            )}

            {/* Textarea with overlay */}
            {/* Textarea with overlay box */}
            <div className="enk-textarea-box" ref={textareaBoxRef}>
              <textarea
                ref={textareaRef}
                className="enk-textarea"
                style={{
                  color: promptData.body.length > 0 ? "transparent" : undefined,
                  caretColor: "var(--enk-text)",
                }}
                value={promptData.body}
                onChange={(e) => {
                  const newBody = e.target.value;
                  setPromptData((prev) => ({ ...prev, body: newBody }));
                  /* Re-evaluate the @-mention state on every
                     keystroke. The detector returns null whenever
                     the caret leaves the active @<query> token,
                     which is our cue to close the dropdown. */
                  const caret = e.target.selectionStart ?? newBody.length;
                  const m = detectMentionAtCaret(newBody, caret);
                  if (m && referenceImages.length > 0) {
                    /* Anchor the dropdown SYNCHRONOUSLY in the same
                       render that flips `mention.open`. Without this
                       we'd render once with open=true but anchor=null
                       (gated out), then rely on a useEffect to set
                       the anchor on the NEXT frame — a noticeable
                       lag where the very first `@` would seemingly
                       do nothing until you typed another character. */
                    const coords = getCaretCoordinates(e.target, m.startPos);
                    setMentionAnchor({
                      top: coords.top + coords.height + 4,
                      left: coords.left,
                      width: 0,
                    });
                    /* Bug fix: also gate on `prev.open`. Previously
                       this returned `prev` whenever (startPos, query)
                       matched — but if prev.open was false (e.g. the
                       user closed the dropdown via Escape/blur, then
                       deleted back to a bare `@` at the same
                       position with empty query), the early return
                       would keep open=false and the dropdown would
                       silently refuse to reappear until they typed
                       another char that changed the query. */
                    setMention((prev) =>
                      prev.open &&
                      prev.startPos === m.startPos &&
                      prev.query === m.query
                        ? prev
                        : { open: true, ...m, highlighted: 0 }
                    );
                  } else if (mention.open) {
                    setMention((prev) => ({ ...prev, open: false }));
                  }
                }}
                onScroll={handleTextareaScroll}
                onSelect={(e) => {
                  handleTextareaSelect(e);
                  /* Caret movements (arrow keys, mouse clicks)
                     should also close the dropdown if the caret
                     leaves the active mention. */
                  const ta = e.currentTarget;
                  const m = detectMentionAtCaret(promptData.body, ta.selectionStart ?? 0);
                  if (!m && mention.open) {
                    setMention((prev) => ({ ...prev, open: false }));
                  }
                }}
                onClick={(e) => selectVariableAtCursor(e.currentTarget)}
                onKeyDown={handleTextareaKeyDown}
                onBlur={() => {
                  /* Blur via Tab/Click outside should close the
                     dropdown — but with a small delay so a click
                     INSIDE the dropdown still registers before the
                     dropdown unmounts. */
                  setTimeout(() => {
                    setMention((prev) => (prev.open ? { ...prev, open: false } : prev));
                  }, 120);
                }}
                spellCheck={false}
                placeholder="Write your prompt here... Select text or use [brackets] for variables."
              />
              {promptData.body.length > 0 && (
                <>
                  <div ref={overlayRef} className="enk-prompt-overlay" aria-hidden>
                    {renderPromptWithTags("display")}
                  </div>
                  <div ref={hitOverlayRef} className="enk-prompt-hit" aria-hidden>
                    {renderPromptWithTags("hit")}
                  </div>
                </>
              )}
            </div>

            {/* @-mention dropdown — `position: fixed`, anchored to
                the @ glyph's viewport coords (see useEffect above)
                so it sits directly under the line the user is typing
                in. Visible only while an active `@…` token is being
                typed AND at least one reference image is available.
                Scrollable when the list exceeds `max-height`. */}
            {mention.open && mentionMatches.length > 0 && mentionAnchor && (
              <div
                ref={(node) => {
                  /* Auto-scroll the highlighted row into view when
                     keyboard navigation moves past the visible
                     window of the dropdown. Runs on every render of
                     the container, so arrow-keying past row 5
                     scrolls row 6 into view. */
                  if (!node) return;
                  const active = node.querySelector<HTMLElement>(
                    ".enk-mention-item--active"
                  );
                  if (active && typeof active.scrollIntoView === "function") {
                    active.scrollIntoView({ block: "nearest" });
                  }
                }}
                className="enk-mention-dropdown"
                role="listbox"
                aria-label="Reference image suggestions"
                style={{
                  top: mentionAnchor.top,
                  left: mentionAnchor.left,
                }}
                onMouseDown={(e) => {
                  /* Prevent the textarea from blurring before our
                     click handler fires — the blur-timeout would
                     otherwise unmount the dropdown mid-click. */
                  e.preventDefault();
                }}
              >
                {mentionMatches.map((item, idx) => {
                  const isActive = idx === mention.highlighted;
                  return (
                    <button
                      key={`mention-${item.idx}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={`enk-mention-item${
                        isActive ? " enk-mention-item--active" : ""
                      }`}
                      onMouseEnter={() =>
                        setMention((m) => ({ ...m, highlighted: idx }))
                      }
                      onClick={() => insertReferenceImageMention(item.idx)}
                    >
                      <img
                        src={item.src}
                        alt=""
                        className="enk-mention-item__thumb"
                        draggable={false}
                      />
                      <span className="enk-mention-item__label">
                        {item.label}
                      </span>
                      {isActive && (
                        <span className="enk-mention-item__check" aria-hidden="true">
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {(() => {
              /* Combined chip row — variables + active reference-image
                 mentions (deduped, in order of first appearance in the
                 prompt body). The reference chips show a tiny
                 thumbnail and open the lightbox on click; variables
                 keep their existing color-coded behaviour. */
              const refMentionIndices: number[] = [];
              const seen = new Set<number>();
              for (const m of promptData.body.matchAll(REF_IMAGE_MENTION_GLOBAL_RE)) {
                const n = parseInt(m[1], 10);
                if (!seen.has(n) && n >= 1 && n <= referenceImages.length) {
                  seen.add(n);
                  refMentionIndices.push(n);
                }
              }
              if (variables.length === 0 && refMentionIndices.length === 0) return null;
              return (
                <div className="enk-prompt-var-tabs">
                  {variables.map((v) => {
                    const colors = getVariableColors(v.colorIndex);
                    const isTabActive = ui.selectedVariableId === v.id;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        className={`enk-prompt-var-tab ${isTabActive ? "enk-prompt-var-tab--active" : ""}`}
                        style={{
                          backgroundColor: colors.bg,
                          color: colors.text,
                          borderColor: colors.border,
                        }}
                        onClick={() => selectVariable(v.id)}
                      >
                        [{v.name || "..."}]
                      </button>
                    );
                  })}
                  {refMentionIndices.map((n) => {
                    const src = referenceImages[n - 1];
                    return (
                      <button
                        key={`refmention-${n}`}
                        type="button"
                        className="enk-prompt-var-tab enk-prompt-var-tab--ref-image"
                        title={`Open Reference image ${n}`}
                        onClick={() => {
                          setRefPreviewDirection("init");
                          setRefPreviewIndex(n - 1);
                        }}
                      >
                        <img
                          src={src}
                          alt=""
                          className="enk-prompt-var-tab__thumb"
                          draggable={false}
                        />
                        <span>Image {n}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })()}

            <div className="enk-prompt-footer">
              <div className="enk-prompt-footer__stat">
                <span className="enk-prompt-footer__stat-value">{promptData.body.length}</span>
                <span className="enk-prompt-footer__stat-label">chars</span>
              </div>
              <div style={{ width: 1, height: 24, background: "var(--enk-border)", opacity: 0.5 }} />
              <div className="enk-prompt-footer__stat">
                <span className="enk-prompt-footer__stat-value">{variables.length}</span>
                <span className="enk-prompt-footer__stat-label">variables</span>
              </div>
              <div
                className="enk-prompt-footer__draft"
                title="Your prompt, variables, and settings are saved in this browser. Leave and come back anytime — your draft will still be here."
              >
                <span className={`enk-prompt-footer__draft-label ${draftSavedAt ? "enk-prompt-footer__draft-label--saved" : ""}`}>
                  {draftSavedAt ? "Draft saved in browser" : "Saving draft…"}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ═══ PANEL 03 — Variables ═══ */}
        <section className="enk-panel enk-panel--variables">
          <div className="enk-panel__header">
            <div style={{ display: "flex", alignItems: "baseline" }}>
              <span className="enk-panel__number">03</span>
              <span className="enk-panel__title">Variables</span>
            </div>
            <span className="enk-panel__meta">defaults & types</span>
          </div>
          <div ref={variablesScrollRef} className="enk-panel__body enk-panel__body--scroll">
            {variables.length === 0 ? (
              <div className="enk-empty">
                <div className="enk-empty__icon"><EmptyVarIcon /></div>
                <div className="enk-empty__title">No variables yet.</div>
                <div className="enk-empty__sub">Select text or use [Name]</div>
              </div>
            ) : (
              variables.map((variable) => {
                const colors = getVariableColors(variable.colorIndex);
                const showNameMissingLine =
                  Boolean(variable.nameBlurEmpty) && !variable.name?.trim();
                const isPulsing = ui.variablePulsingId === variable.id;
                const isSelected = ui.selectedVariableId === variable.id;
                return (
                <div
                  key={variable.id}
                  ref={(el) => {
                    if (el) variableCardRefs.current[variable.id] = el;
                    else delete variableCardRefs.current[variable.id];
                  }}
                  className={`enk-var-card${isSelected ? " enk-var-card--selected" : ""}${isPulsing ? " enk-var-card--pulse" : ""}${variable.nameMissingHighlighted ? " enk-var-card--name-missing" : ""}`}
                  style={{
                    /* `nameMissingHighlighted` overrides the per-variable
                       color so the red border isn't fighting the inline
                       border-color from React. The CSS class also sets
                       `!important` for the same reason. */
                    borderColor: variable.nameMissingHighlighted
                      ? "#ef4444"
                      : colors.border,
                    borderLeftWidth: 3,
                    borderLeftColor: variable.nameMissingHighlighted
                      ? "#ef4444"
                      : colors.border,
                    ...(isPulsing
                      ? ({ ["--var-pulse-border" as string]: colors.border } as React.CSSProperties)
                      : {}),
                    ...(isSelected
                      ? ({ ["--var-card-border" as string]: colors.border } as React.CSSProperties)
                      : {}),
                  }}
                  onMouseDownCapture={(e) => {
                    if ((e.target as HTMLElement).closest(".enk-var-card__delete")) return;
                    selectVariable(variable.id);
                  }}
                >
                  <div className="enk-var-card__top">
                    <div className="enk-var-card__label">VARIABLE NAME</div>
                    <button
                      type="button"
                      className="enk-var-card__delete"
                      aria-label="Delete variable"
                      title="Delete variable"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setUi((p) => ({ ...p, variableDeleteId: variable.id }));
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <input
                    className={`enk-var-card__name-input ${showNameMissingLine ? "enk-var-card__name-input--name-missing" : ""}`}
                    value={variable.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      updateVariable(variable.id, { name });
                      if (name.trim()) {
                        // Name is now valid: drop both the on-blur empty
                        // flag AND the red-border highlight set by the
                        // "Variable names required" alert so the visual
                        // warnings disappear the moment the user fixes
                        // the issue.
                        setVariables((prev) =>
                          prev.map((v) =>
                            v.id === variable.id
                              ? {
                                  ...v,
                                  nameBlurEmpty: false,
                                  nameMissingHighlighted: false,
                                }
                              : v
                          )
                        );
                      }
                    }}
                    onFocus={() => handleVariableNameFocus(variable.id)}
                    onBlur={() => handleVariableNameBlur(variable.id)}
                    placeholder="e.g. Subject"
                    title={!variable.name ? "Fill in the variables." : "Variable name used in prompt logic."}
                  />

                  {/* Type toggle */}
                  <div className="enk-type-toggle">
                    <button
                      className={`enk-type-toggle__btn ${variable.type === "text" ? "enk-type-toggle__btn--active" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        requestVariableTypeChange(variable.id, "text");
                      }}
                    >
                      Text input
                    </button>
                    <button
                      className={`enk-type-toggle__btn ${variable.type === "checkbox" ? "enk-type-toggle__btn--active" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        requestVariableTypeChange(variable.id, "checkbox");
                      }}
                    >
                      Yes / No checkbox
                    </button>
                  </div>

                  {/* Default value section */}
                  <div className="enk-var-card__label">DEFAULT VALUE</div>
                  {variable.type === "text" || variable.type === "image" ? (
                    <>
                      <input
                        className="enk-var-card__default-input"
                        value={String(variable.defaultValue || "")}
                        onChange={(e) => updateVariable(variable.id, { defaultValue: e.target.value, type: "text" })}
                        placeholder="e.g. a young woman..."
                      />
                      <div className="enk-var-card__hint">Used until the buyer changes it.</div>
                    </>
                  ) : (
                    <>
                      <div className="enk-toggle-inserts-row">
                        <label className="enk-checkbox" onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--enk-hint)' }}>
                          <input
                            type="checkbox"
                            checked={variable.defaultValue as boolean}
                            onChange={(e) => updateVariable(variable.id, { defaultValue: e.target.checked })}
                            style={{ accentColor: 'var(--enk-accent)', width: 14, height: 14, borderRadius: 3 }}
                          />
                          <span>Default: <span style={{ fontWeight: 600, color: 'var(--enk-dark)' }}>{variable.defaultValue ? "on" : "off"}</span></span>
                        </label>
                      </div>
                      <textarea
                        className="enk-var-card__desc-input"
                        value={variable.description}
                        onChange={(e) => updateVariable(variable.id, { description: e.target.value })}
                        placeholder="Add text to insert when checked..."
                        rows={2}
                      />
                    </>
                  )}
                </div>
                );
              })
            )}
          </div>

          {/* Reference-images upload UI lives in Settings now (under
              "REFERENCE IMAGES" / "PROMPT RELEVANT REFERENCE IMAGES")
              because the data is part of the prompt definition, not a
              per-render artefact attached to variable cards. */}
        </section>

        {/* ═══ PANEL 04 — Verify ═══ */}
        <section className="enk-panel enk-panel--verify">
          {/* Dual-Arrow Bridge — Circuit Track Design */}
          <div
            className={`enk-bridge-overlay${ui.selectedCards.length === 1 ? " enk-bridge-overlay--back-active" : ""}${!hasPromptBody ? " enk-bridge-overlay--forward-blocked" : ""}`}
          >
            <button
              className={`enk-arrow-btn enk-arrow-btn--back ${ui.selectedCards.length === 1 ? "enk-arrow-btn--active" : ""}`}
              disabled={ui.selectedCards.length !== 1}
              onClick={() => {
                const card = versions.find((v) => v.id === ui.selectedCards[0]);
                if (!card) return;
                // If the user already has variable defaults set, the
                // overwrite is destructive — surface our own AlertDialog
                // (matching the "Delete variable" style) instead of the
                // browser's native window.confirm. If no defaults exist,
                // overwriting is a no-op for them and we just run.
                const hasExistingDefaults = variables.some(
                  (v) => v.defaultValue
                );
                if (hasExistingDefaults) {
                  setUi((p) => ({
                    ...p,
                    editOverwriteConfirmCardId: card.id,
                  }));
                  return;
                }
                applyVerifyCardToVariableDefaults(card.id);
              }}
              title="Edit — send selected back to Variables"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            </button>
            <div className="enk-bridge-track">
              <div className="enk-bridge-track__dot" />
              <div className="enk-bridge-track__line" />
              <div className="enk-bridge-track__dot" />
            </div>
            <button
              type="button"
              className={`enk-arrow-btn enk-arrow-btn--forward${!hasPromptBody ? " enk-arrow-btn--forward-inactive" : ""}${canPushToVerify ? " enk-arrow-btn--active enk-arrow-btn--glow" : ""}`}
              disabled={!hasPromptBody}
              aria-disabled={!hasPromptBody}
              tabIndex={hasPromptBody ? 0 : -1}
              onMouseDown={
                !hasPromptBody
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }
                  : undefined
              }
              onClick={
                hasPromptBody
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      // Defensive re-check at click time — body may have
                      // been cleared between paint and click.
                      if (!hasSubstantivePromptBody(promptData.body)) return;
                      // Block the push when one or more variables still
                      // have an empty name. We open the alert dialog and
                      // stop here; the OK button on the dialog tags the
                      // offending variables with a red border so the user
                      // can spot them in both the prompt and the cards.
                      const hasUnnamedVariable = variables.some(
                        (v) => !v.name.trim()
                      );
                      if (hasUnnamedVariable) {
                        setUi((p) => ({
                          ...p,
                          variableNameMissingAlertOpen: true,
                        }));
                        return;
                      }
                      handleStackVariables();
                    }
                  : undefined
              }
              title={
                !hasPromptBody
                  ? "Write a prompt first"
                  : variables.length === 0
                    ? "Push prompt to Verify"
                    : "Push variables to Verify"
              }
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
          </div>

          <div className="enk-panel__header">
            <div style={{ display: "flex", alignItems: "baseline" }}>
              <span className="enk-panel__number">04</span>
              <span className="enk-panel__title">Verify</span>
            </div>
            <span className="enk-panel__meta">
              {promptData.type === "free-prompt" ? `${verifiedCount}/1 req · 4 rec` : `${verifiedCount}/4 required`}
            </span>
          </div>
          <div className="enk-panel__body">
            <p className="enk-hint-text" style={{ marginBottom: 16 }}>
              {promptData.type === "free-prompt"
                ? "Free prompts need at least one reference render. Four is recommended — buyers trust prompts that prove they generalize."
                : "Premium prompts require exactly four reference renders to prove they generate consistently high-quality results."}
            </p>

            {versions.map((slot) => {
              const isSelected = ui.selectedCards.includes(slot.id);
              return (
                  <div key={slot.id} className="enk-version-card-wrapper">
                    <div
                      className={`enk-version-card ${isSelected ? "enk-version-card--selected" : ""}`}
                      onClick={() => toggleVersionCheckbox(slot.id)}
                      style={{ cursor: "pointer" }}
                    >
                      {/* Image panel — always visible */}
                      <div className="enk-version-card__thumb">
                        {slot.status === "complete" && slot.imageUrl && (
                          <img
                            src={slot.imageUrl}
                            alt={`Version ${String(slot.id).padStart(2, "0")}`}
                          />
                        )}
                        {slot.status === "generating" && (
                          <div className="enk-spinner" />
                        )}
                        {slot.status === "queued" && (
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, zIndex: 2 }}>
                            <span style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: "#c0542a" }}>#{slot.queuePosition}</span>
                            <span style={{ fontFamily: "monospace", fontSize: 9, color: "#888", letterSpacing: "0.1em" }}>IN QUEUE</span>
                          </div>
                        )}
                        {slot.status === "failed" && (
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "0 10px", textAlign: "center", zIndex: 2 }}>
                            <AlertTriangle color="#c0542a" size={20} />
                            <span style={{ fontFamily: "monospace", fontSize: 9, color: "#c0542a", letterSpacing: "0.05em" }}>FAILED</span>
                          </div>
                        )}
                        {/* Overlay: status */}
                        <span className="enk-version-card__overlay-status">
                          {slot.status === "complete" ? "● ready" :
                           slot.status === "generating" ? "● generating" :
                           slot.status === "queued" ? `● queue` :
                           slot.status === "failed" ? "● failed" :
                           ""}
                        </span>
                        {/* Overlay: version label */}
                        <span className="enk-version-card__overlay-label">
                          Version {String(slot.id).padStart(2, "0")}
                        </span>
                      </div>

                      {/* Metadata panel */}
                      <div className="enk-version-card__info">
                        <div className="enk-verify-var-chips">
                          {Object.entries(slot.variableSnapshot)
                            .filter(([key]) => key?.trim())
                            .map(([key, val]) => {
                              const variable = variables.find((v) => v.name === key);
                              const colors = variable
                                ? getVariableColors(variable.colorIndex)
                                : null;
                              const chipValue = formatVerifySnapshotValue(
                                String(val ?? ""),
                                variable
                              );
                              return (
                                /* Display-only chip — clicking it bubbles up to
                                   mark the card; the full value stays in the
                                   native hover tooltip. */
                                <span
                                  key={`${slot.id}-${key}`}
                                  className="enk-verify-var-chip"
                                  title={chipValue ? `${key}: ${chipValue}` : key}
                                  style={
                                    colors
                                      ? ({
                                          backgroundColor: colors.bg,
                                          color: colors.text,
                                          borderColor: colors.border,
                                        } as React.CSSProperties)
                                      : undefined
                                  }
                                >
                                  <span className="enk-verify-var-chip__name">{key}</span>
                                  {chipValue && chipValue !== "—" && (
                                    <span className="enk-verify-var-chip__value">{chipValue}</span>
                                  )}
                                </span>
                              );
                            })}
                        </div>

                        {/* Per-card reference images — an add button plus an
                            overlapping stack. Only the buttons stop propagation;
                            clicking the row still marks the card. */}
                        <div className="enk-verify-refs">
                          <span className="enk-verify-refs__label">refs</span>
                          <div className="enk-verify-refs__row">
                            {(slot.referenceImages?.length ?? 0) < MAX_VERIFY_REFS && (
                              <button
                                type="button"
                                className="enk-verify-ref-add"
                                aria-label="Add reference image"
                                title="Add reference image"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  pickVerifyCardRefs(slot.id);
                                }}
                              >
                                <Plus size={14} strokeWidth={2} />
                              </button>
                            )}
                            {(slot.referenceImages?.length ?? 0) > 0 && (
                              <div className="enk-verify-ref-stack">
                                {(slot.referenceImages ?? []).map((src, i) => (
                                  <div
                                    key={`${slot.id}-ref-${i}`}
                                    className="enk-verify-ref-slot"
                                    style={{ zIndex: i + 1 }}
                                  >
                                    <img src={src} alt={`Reference ${i + 1}`} />
                                    <button
                                      type="button"
                                      className="enk-verify-ref-slot__remove"
                                      aria-label={`Remove reference ${i + 1}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        removeVerifyCardRef(slot.id, i);
                                      }}
                                    >
                                      <X size={9} strokeWidth={2.5} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Download link for complete cards */}
                        {slot.status === "complete" && slot.imageUrl && (
                          <div className="enk-version-card__row enk-version-card__row--download">
                            <button
                              type="button"
                              className="enk-version-card__download"
                              onClick={(e) => {
                                e.stopPropagation();
                                const a = document.createElement("a");
                                a.href = slot.imageUrl!;
                                a.download = `version-${slot.id}.png`;
                                a.click();
                              }}
                            >
                              save
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div style={{ height: 24, flexShrink: 0 }} />

            {/* Multi-select action bar — Delete only OR Delete & Refill */}
            {ui.selectedCards.length > 0 && (
              <div className="enk-refill-bar">
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontFamily: "var(--font-jetbrains-mono), monospace", fontSize: 10, color: "var(--enk-dark)", fontWeight: 600 }}>{ui.selectedCards.length} selected</span>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    className="enk-refill-bar__delete"
                    onClick={deleteSelectedVersions}
                  >
                    Delete only
                  </button>
                  <button
                    className="enk-refill-bar__refill"
                    onClick={handleRefillAndGenerate}
                  >
                    Refill
                    <span className="enk-refill-bar__cost">{slotPrice(ui.selectedCards.length)}</span>
                  </button>
                  <button
                    className="enk-refill-bar__cancel"
                    onClick={() => setUi(prev => ({ ...prev, selectedCards: [] }))}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Prompt Ownership Notice — keeps the original cream look,
              now dismissible via the X in the top-right corner. The
              outer wrapper handles a slide-down + fade-out animation
              when the user clicks dismiss; the inner box keeps the
              existing inline styling so the visual stays identical. */}
          {!ui.ownershipNoticeDismissed && (
            <div
              style={{
                overflow: "hidden",
                maxHeight: noticeLeaving ? 0 : 200,
                opacity: noticeLeaving ? 0 : 1,
                transform: noticeLeaving ? "translateY(8px)" : "translateY(0)",
                transition:
                  "max-height 260ms ease, opacity 200ms ease, transform 260ms ease",
                pointerEvents: noticeLeaving ? "none" : undefined,
              }}
            >
              <div
                style={{
                  padding: "8px 12px",
                  background: "#fffaf0",
                  borderTop: "1px solid #f5e6cc",
                  borderBottom: "1px solid #f5e6cc",
                  position: "relative",
                }}
              >
                <button
                  type="button"
                  aria-label="Dismiss ownership notice"
                  title="Dismiss"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (noticeLeaving) return;
                    setNoticeLeaving(true);
                    window.setTimeout(() => {
                      dismissOwnershipNotice();
                    }, 280);
                  }}
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 6,
                    width: 22,
                    height: 22,
                    padding: 0,
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    color: "#8a6d3b",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 3,
                    lineHeight: 1,
                    flexShrink: 0,
                    transition:
                      "background 0.12s ease, color 0.12s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background =
                      "rgba(184, 134, 11, 0.14)";
                    e.currentTarget.style.color = "#5a4a1f";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "#8a6d3b";
                  }}
                >
                  <X size={12} />
                </button>
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    alignItems: "flex-start",
                    paddingRight: 22,
                  }}
                >
                  <AlertTriangle
                    size={14}
                    style={{
                      color: "#b8860b",
                      marginTop: "1px",
                      flexShrink: 0,
                    }}
                  />
                  <p
                    style={{
                      fontSize: 11,
                      color: "#8a6d3b",
                      lineHeight: 1.4,
                      margin: 0,
                    }}
                  >
                    <strong>Ownership Notice:</strong> Only mark prompts as
                    your own property if you genuinely created them. Falsely
                    claiming authorship will result in account strikes. See
                    Terms.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Consolidated Action Bar */}
          <div style={{ background: "var(--enk-warm-white)", borderTop: "1px solid var(--enk-border)", padding: "10px 12px", zIndex: 10, marginTop: "auto" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Cost summary */}
              {versions.some(v => v.status === "idle" || v.status === "failed") && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: "var(--enk-panel)", border: "1px solid var(--enk-border)" }}>
                  <span style={{ fontFamily: "var(--font-jetbrains-mono), monospace", fontSize: "clamp(9px, 0.6vw + 6px, 12px)", color: "var(--enk-muted)", letterSpacing: 1, textTransform: "uppercase" }}>Batch cost</span>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ fontFamily: "var(--font-jetbrains-mono), monospace", fontSize: "clamp(12px, 0.8vw + 8px, 16px)", fontWeight: 700, color: "var(--enk-dark)" }}>
                      {slotPrice(Math.max(versions.filter(v => v.status === "idle" || v.status === "failed").length, variables.filter(v => v.type === "text").length > 0 ? Math.max(...variables.filter(v => v.type === "text").map(v => v.values.length || 1)) : 1))}
                    </span>
                    <span style={{ fontFamily: "var(--font-jetbrains-mono), monospace", fontSize: "clamp(9px, 0.5vw + 6px, 11px)", color: "var(--enk-hint)" }}>
                      via {currentNetworkName}
                    </span>
                  </div>
                </div>
              )}
              {/* Action Buttons Row */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                <button
                  className="enk-btn enk-btn--ghost enk-btn--sm"
                  style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 6px", color: "var(--enk-muted)", fontFamily: "var(--font-jetbrains-mono), monospace", fontSize: 9, whiteSpace: "nowrap" }}
                  onClick={handleGrokFill}
                  disabled={ui.isGrokFilling}
                >
                  <Sparkles size={10} />
                  {ui.isGrokFilling ? "Filling..." : "Auto Fill"}
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <DiceButton
                    variables={diceVariables}
                    context={promptData.body.slice(0, DICE_LIMITS.maxContextLen)}
                    headers={sessionAuthHeaders()}
                    onValues={applyDiceValues}
                    size={12}
                  />
                  <button
                    className="enk-pay-btn"
                    onClick={handlePayAndGenerate}
                    disabled={
                      isGeneratingPaymentPending || 
                      versions.filter(v => v.status === "idle" || v.status === "failed").length === 0 ||
                      (promptData.type === "premium-prompt" && variables.some(v => !v.name))
                    }
                    style={{ padding: "6px 8px", height: "auto", whiteSpace: "nowrap", fontSize: 9 }}
                  >
                    {isGeneratingPaymentPending ? (
                      <>● Processing...</>
                    ) : (
                      <>
                        <Zap size={10} />
                        Pay &amp; Gen
                        {versions.filter(v => v.status === "idle" || v.status === "failed").length > 0 && (
                          <span style={{ marginLeft: 4, opacity: 0.6, fontWeight: 400, fontSize: 8 }}>
                            ({versions.filter(v => v.status === "idle" || v.status === "failed").length})
                          </span>
                        )}
                      </>
                    )}
                  </button>
                  <button
                    className="enk-btn enk-btn--primary enk-btn--sm"
                    style={{ padding: "6px 8px", background: isPublishDisabled ? "#D5D1CB" : "var(--enk-dark)", borderColor: isPublishDisabled ? "#D5D1CB" : "var(--enk-dark)", color: "white", opacity: 1, cursor: isPublishDisabled ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
                    disabled={isPublishDisabled}
                    onClick={handleReleaseClick}
                  >
                    {publishPromptMutation.isPending ? "Releasing…" : "Release"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Mobile Base View (Background for Modal) */}
      {isMobileViewport && (
        <div style={{ position: "fixed", inset: 0, background: "#f2efe8", zIndex: 100 }}>
          <div style={{ padding: "40px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: "var(--font-serif), 'Playfair Display', serif", fontSize: 28, fontStyle: "italic", fontWeight: 700, color: "#9A938A", letterSpacing: "-1px" }}>Enki.</span>
            <div style={{ width: 16, height: 4, background: "#C4BDB5", borderRadius: 2 }}></div>
          </div>
          <div style={{ display: "flex", gap: 16, padding: "0 20px" }}>
            <div style={{ width: 160, height: 160, borderRadius: 12, background: "#C4BDB5", opacity: 0.5 }}></div>
            <div style={{ width: 160, height: 160, borderRadius: 12, background: "#C4BDB5", opacity: 0.5 }}></div>
          </div>
        </div>
      )}

      {/* Mobile Floating Button */}
      {isMobileViewport && !isMobileModalOpen && (
        <div style={{ position: "fixed", bottom: 24, left: 24, right: 24, zIndex: 150 }}>
          <button 
            style={{ width: "100%", background: "var(--enk-dark)", color: "white", padding: "16px 24px", borderRadius: 32, display: "flex", justifyContent: "space-between", alignItems: "center", border: "none", boxShadow: "0 12px 32px rgba(0,0,0,0.2)", cursor: "pointer" }}
            onClick={() => setIsMobileModalOpen(true)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Sparkles size={18} style={{ fill: "white" }} />
              <span style={{ fontFamily: "var(--font-outfit), 'Outfit', sans-serif", fontSize: 16, fontWeight: 500 }}>Generate</span>
            </div>
            <span style={{ fontFamily: "var(--font-serif), 'Playfair Display', serif", fontStyle: "italic", fontSize: 15, color: "#9A938A" }}>new image</span>
          </button>
        </div>
      )}

      {/* Render Mobile Modal */}
      <EnkiMobileGenerateModal
        isOpen={isMobileModalOpen}
        onClose={() => setIsMobileModalOpen(false)}
        promptBody={promptData.body}
        setPromptBody={(val) => setPromptData(prev => ({ ...prev, body: val }))}
        variables={variables}
        onVariableChange={(id, val) => {
          setVariables(prev => prev.map(v => 
            v.id === id ? { ...v, defaultValue: val, values: [val] } : v
          ));
        }}
        onAddVariable={() => {
          const newVarName = `var_${variables.length + 1}`;
          setPromptData(prev => ({ ...prev, body: prev.body + ` [${newVarName}]` }));
        }}
        onRemoveVariable={(name) => {
          setPromptData(prev => ({ ...prev, body: prev.body.split(`[${name}]`).join('') }));
        }}
        models={models}
        setModel={(id) => setModels(prev => ({ ...prev, selected: [id] }))}
        resolution={genResolution}
        setResolution={(v) => { if (v === "1K" || v === "2K" || v === "4K") setGenResolution(v); }}
        resolutionOptions={genTiers.map((t) => ({ value: t, label: t }))}
        ratios={ratios}
        setRatio={(r) => setRatios(prev => ({ ...prev, selected: r }))}
        priceFor={slotPrice}
        modelPriceLabel={modelPriceLabel}
        requiredVariations={promptData.type === "free-prompt" ? 1 : 4}
        onRelease={handleReleaseClick}
        /* The sheet's Settings edit the editor's own state: a release sends
           and checks that state, and on a phone the sheet is the only place
           to fill it. Unwired, the sheet kept a private copy nobody read. */
        title={promptData.title}
        setTitle={(v) => setPromptData((prev) => ({ ...prev, title: v }))}
        promptType={promptData.type}
        setPromptType={(v) => {
          if (v !== "free-prompt" && v !== "premium-prompt") return;
          setPromptData((prev) => ({ ...prev, type: v }));
          if (v === "premium-prompt") setUi((p) => ({ ...p, pricePerRenderReviewed: false }));
        }}
        tags={promptData.tags}
        onAddTag={(t) => setPromptData((prev) => ({ ...prev, tags: [t.toLowerCase()] }))}
        onRemoveTag={removeTag}
        price={promptPrice}
        setPrice={(v) => { setPromptPrice(v); setUi((p) => ({ ...p, pricePerRenderReviewed: true })); }}
        onAutoFill={handleGrokFill}
        isAutoFilling={ui.isGrokFilling}
        onGenerate={(count) => {
          if (!picked) {
            toast({ title: "Pick a model", description: "Choose the model to generate with.", variant: "destructive" });
            return;
          }
          if (!picked.free && !walletConnected) {
            setShowWalletPicker(true);
            toast({ title: "Wallet required", description: "Connect a wallet to pay for this generation.", variant: "destructive" });
            return;
          }
          const snapshot: Record<string, string> = {};
          variables.forEach(v => { snapshot[v.name] = (v.defaultValue as string) || v.name; });
          // As many images as the sheet shows and prices, one payment each.
          const base = versions.length > 0 ? Math.max(...versions.map(v => v.id)) + 1 : 1;
          const ids = Array.from({ length: count }, (_, i) => base + i);
          setVersions(prev => [...prev, ...ids.map((id) => ({ id, variableSnapshot: snapshot, imageUrl: null, status: "idle" as const }))]);
          toast({ title: `Paying ${slotPrice(count)}`, description: count > 1 ? "Each image is paid separately from your wallet." : "Processing the payment for this generation..." });
          ids.forEach((id, i) => setTimeout(() => { handleGenerateVersion(id); }, 100 + i * 400));
        }}
      />

      {/* ═══ Reference-image Lightbox ═══
          Fullscreen viewer for the prompt's reference images.

          Rendered through `createPortal` straight onto `document.body`
          so it ESCAPES the editor wrapper's stacking context (the
          page wraps everything in `position: fixed; zIndex: 100`,
          which would otherwise trap the lightbox below the global
          Navbar at zIndex: 200). With the portal the lightbox is a
          sibling of the navbar in the DOM, and its z-index 9999
          comparison happens at the document root — image always
          wins, navbar disappears underneath.

          Triggers: plain click on a slot tile (no drag-overlap).
          Dismissals: Escape, "×" button, click on backdrop.
          Navigation: ←/→ keys, on-screen prev/next buttons.
          The top-center counter is ALWAYS visible while open;
          close/prev/next chrome fades in on hover. */}
      {typeof document !== "undefined" &&
        refPreviewIndex !== null &&
        referenceImages[refPreviewIndex] &&
        createPortal(
          <div
            className="enk-ref-preview"
            role="dialog"
            aria-modal="true"
            aria-label={`Reference image ${refPreviewIndex + 1} of ${referenceImages.length}`}
            onClick={() => setRefPreviewIndex(null)}
          >
            <div className="enk-ref-preview__counter">
              Reference image {refPreviewIndex + 1}
              {referenceImages.length > 1 ? ` / ${referenceImages.length}` : ""}
            </div>

            <button
              type="button"
              className="enk-ref-preview__close"
              aria-label="Close preview"
              onClick={(e) => {
                e.stopPropagation();
                setRefPreviewIndex(null);
              }}
            >
              <X size={18} />
            </button>

            {referenceImages.length > 1 && (
              <>
                <button
                  type="button"
                  className="enk-ref-preview__nav enk-ref-preview__nav--prev"
                  aria-label="Previous reference image"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRefPreviewDirection("prev");
                    setRefPreviewIndex((i) =>
                      i === null
                        ? null
                        : (i - 1 + referenceImages.length) % referenceImages.length
                    );
                  }}
                >
                  <ChevronLeft size={24} />
                </button>
                <button
                  type="button"
                  className="enk-ref-preview__nav enk-ref-preview__nav--next"
                  aria-label="Next reference image"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRefPreviewDirection("next");
                    setRefPreviewIndex((i) =>
                      i === null ? null : (i + 1) % referenceImages.length
                    );
                  }}
                >
                  <ChevronRight size={24} />
                </button>
              </>
            )}

            <img
              key={refPreviewIndex}
              src={referenceImages[refPreviewIndex]}
              alt={`Reference ${refPreviewIndex + 1}`}
              className={`enk-ref-preview__img enk-ref-preview__img--${refPreviewDirection}`}
              draggable={false}
              onClick={(e) => e.stopPropagation()}
            />
          </div>,
          document.body
        )}

      {/* ═══ Reference-image hover tooltip ("Sprechblase") ═══
          Rendered when the user hovers an `@Image{N}` chip in the
          prompt body. Portalled to `document.body` for the same
          reason as the lightbox — escapes the editor wrapper's
          stacking context so it can float above ANY ancestor with
          its own `overflow: hidden` / `transform` boundary.
          Position is computed from the chip's snapshotted bounding
          rect: bubble sits ABOVE the chip when there's room (the
          common case, since chips appear inside the textarea which
          sits well below the navbar), otherwise flips to BELOW.
          The CSS `::after` pseudo draws the speech-bubble tip
          pointing back at the chip's horizontal center. */}
      {typeof document !== "undefined" &&
        refTooltip &&
        referenceImages[refTooltip.imageIndex - 1] &&
        createPortal(
          (() => {
            /* Flip below the chip if hovering near the top of the
               viewport leaves no room for the bubble above. The
               bubble plus arrow plus a little breathing room is
               about 220px; under that, point it down. */
            const flipBelow = refTooltip.anchor.top < 220;
            const top = flipBelow
              ? refTooltip.anchor.bottom + 10
              : refTooltip.anchor.top - 10;
            return (
              <div
                className={`enk-ref-tooltip enk-ref-tooltip--${
                  flipBelow ? "below" : "above"
                }`}
                style={{
                  position: "fixed",
                  top,
                  left: refTooltip.anchor.centerX,
                  zIndex: 9000,
                  pointerEvents: "none",
                }}
                aria-hidden="true"
              >
                <img
                  src={referenceImages[refTooltip.imageIndex - 1]}
                  alt=""
                  className="enk-ref-tooltip__img"
                  draggable={false}
                />
                <div className="enk-ref-tooltip__label">
                  Reference image {refTooltip.imageIndex}
                </div>
              </div>
            );
          })(),
          document.body
        )}

      {/* ESC → keep the (autosaved) draft, or wipe it and leave. */}
      <AlertDialog open={leaveConfirm} onOpenChange={setLeaveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Keep your work?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Save them as a draft in your browser — the editor will
              look exactly like this when you come back — or throw them away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setLeaveConfirm(false); handleNewPrompt(); router.push("/home"); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard & leave
            </AlertDialogAction>
            <AlertDialogAction onClick={() => { setLeaveConfirm(false); router.push("/home"); }}>
              Save draft & leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </>
  );
}
