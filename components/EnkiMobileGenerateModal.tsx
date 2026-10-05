import BoostToggle from "@/components/generation/BoostToggle";
import DiceButton from "@/components/DiceButton";
import type { DiceValue, DiceVariable } from "@/lib/generation/variable-dice";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { ENKI_CATEGORIES } from "@/components/enki/EnkiFilters";
import { priceInputText, priceOf, priceTextFor } from "@/lib/editor/price-input";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Sparkles, Plus, ImageIcon, Ratio, Maximize2, Copy, Settings, FileText, CheckCircle2 } from "lucide-react";
import { getVariableColors } from "../lib/variableColors";
import "../app/editor/mobile-modal.css"; // We will create this next

// The categories the desktop editor saves and the feed filters by, stored in lower case.
const CATEGORY_OPTIONS = ENKI_CATEGORIES.map((label) => ({ value: label.toLowerCase(), label }));

interface PromptVariable {
  id: string;
  name: string;
  label: string;
  type: string;
  defaultValue: string | boolean;
  values: string[];
  colorIndex?: number;
}

/**
 * Editable prompt field that highlights `[variable]` tokens in colour,
 * mirroring the prompt editor. A transparent textarea sits on top of a
 * colour backdrop so the caret/typing stays native while the tokens get
 * their pastel pills. Both layers share identical typography (via the
 * `.mobile-modal-hl-*` classes) so the text aligns pixel-for-pixel.
 */
function HighlightedPromptInput({
  value,
  onChange,
  placeholder,
  variables,
  onSelectionChange,
}: {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  variables: PromptVariable[];
  onSelectionChange?: (start: number, end: number) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLDivElement>(null);

  const reportSelection = () => {
    const ta = taRef.current;
    if (ta && onSelectionChange) onSelectionChange(ta.selectionStart, ta.selectionEnd);
  };

  const colorByToken = useMemo(() => {
    const map: Record<string, ReturnType<typeof getVariableColors>> = {};
    variables.forEach((v, i) => {
      map[`[${v.name}]`] = getVariableColors(
        typeof v.colorIndex === "number" ? v.colorIndex : i
      );
    });
    return map;
  }, [variables]);

  const syncScroll = () => {
    if (backRef.current && taRef.current) {
      backRef.current.scrollTop = taRef.current.scrollTop;
      backRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  const parts = value.split(/(\[[^\]\n]+\])/g);

  return (
    <div className="mobile-modal-hl-wrap">
      <div className="mobile-modal-hl-backdrop" ref={backRef} aria-hidden="true">
        {parts.map((part, i) => {
          const colors = /^\[[^\]\n]+\]$/.test(part) ? colorByToken[part] : null;
          if (colors) {
            return (
              <span
                key={i}
                className="mobile-modal-hl-pill"
                style={{
                  background: colors.bg,
                  color: colors.text,
                  boxShadow: `inset 0 0 0 1px ${colors.border}`,
                }}
              >
                {part}
              </span>
            );
          }
          return <span key={i}>{part}</span>;
        })}
        {"\n"}
      </div>
      <textarea
        ref={taRef}
        className="mobile-modal-hl-textarea"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onSelect={reportSelection}
        onKeyUp={reportSelection}
        onMouseUp={reportSelection}
      />
    </div>
  );
}

interface EnkiMobileGenerateModalProps {
  isOpen: boolean;
  onClose: () => void;
  promptBody: string;
  setPromptBody?: (val: string) => void;
  variables: PromptVariable[];
  onVariableChange?: (id: string, val: string) => void;
  onAddVariable?: () => void;
  onRemoveVariable?: (name: string) => void;
  models: { available: any[], selected: string[] };
  setModel?: (id: string) => void;
  ratios: { available: string[], selected: string };
  setRatio?: (val: string) => void;
  /** The server quote for n images, "Free", or "…" while none is known. */
  priceFor: (count: number) => string;
  /** The server quote for one image on a model, for model options. */
  modelPriceLabel?: (id: string) => string | undefined;
  /** Generates exactly the number of images the sheet shows and prices. */
  onGenerate: (count: number) => void;
  onAutoFill?: () => void;
  isAutoFilling?: boolean;
  /* Which tab to land on when the sheet opens. The editor opens straight into
     "Release" on mobile (it IS the mobile editor); the feed launcher stays on
     "Generate". */
  initialTab?: "Generate" | "Release";
  /* Feed launcher additions (all optional → editor usage unchanged):
     hide the Release tab and surface reference-image inputs. */
  hideReleaseTab?: boolean;
  referenceImages?: string[];
  onAddReferenceImages?: (files: FileList) => void;
  onRemoveReferenceImage?: (index: number) => void;
  /* Reorder the image card deck (drag-and-drop in the footer). */
  onReorderReferenceImages?: (from: number, to: number) => void;
  /* Pick reference images from the connected wallet's NFTs (separate from the
     plain file upload). When provided, an "+ NFT" button appears with its own
     card deck. */
  onPickNFT?: () => void;
  /* Selected NFT references — rendered as a separate card deck from uploads. */
  nftImages?: string[];
  onRemoveNFT?: (index: number) => void;
  onReorderNFTs?: (from: number, to: number) => void;
  generateLabel?: string;
  /** Boost: same model on a priority host. Omit onBoostChange to hide it. */
  boost?: boolean;
  onBoostChange?: (next: boolean) => void;
  /** Resolution, owned by the parent when provided — with the option list
      derived from the model's real ceiling and prices (useGenerationCore).
      Absent, the modal keeps its internal 2K/4K fallback (legacy editor). */
  resolution?: string;
  setResolution?: (v: string) => void;
  resolutionOptions?: Array<{ value: string; label: string; short?: string }>;
  /* Freshly generated images to surface ABOVE the sheet (newest first). */
  resultImages?: string[];
  isGenerating?: boolean;
  /* Release flow: how many verified variations are required before publishing.
     Defaults to 1 for free prompts, 4 for paid. onRelease fires the publish action. */
  requiredVariations?: number;
  onRelease?: () => void;
  /* Editor left-column settings (all optional → fall back to internal state).
     Provided by EnkiPromptEditor so the mobile Settings tab mirrors the browser editor. */
  title?: string;
  setTitle?: (v: string) => void;
  promptType?: string;
  setPromptType?: (v: string) => void;
  tags?: string[];
  onAddTag?: (t: string) => void;
  onRemoveTag?: (t: string) => void;
  price?: number;
  setPrice?: (v: number) => void;
  /* Multi-select model toggle (editor). Falls back to single-select via setModel. */
  onToggleModel?: (id: string) => void;
  /* Desktop only: opens the full /editor instead of showing the Release flow. */
  onOpenPromptEditor?: () => void;
}

/**
 * Compact single-select used in the footer settings row. Unlike a native
 * <select>, the options panel is rendered inside the modal and opens UPWARD,
 * so it never spills outside the sheet frame (desktop or mobile).
 */
function MiniSelect({
  value,
  options,
  onChange,
  icon,
  title,
  maxWidth,
  fixedWidth,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  icon?: React.ReactNode;
  title?: string;
  maxWidth?: number;
  /** FIXED trigger width — the control never resizes with the selection
      (Kev, 2026-08-24: "UIs change positions when changing things"). */
  fixedWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className="mobile-modal-setting" title={title}>
      {icon}
      <div className="mobile-modal-minisel" ref={ref}>
        <button
          type="button"
          className="mobile-modal-select mobile-modal-select--mini mobile-modal-minisel-trigger"
          style={fixedWidth ? { width: fixedWidth } : maxWidth ? { maxWidth } : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="mobile-modal-minisel-value">{(current as { short?: string } | undefined)?.short ?? current?.label ?? value}</span>
        </button>
        {open && (
          <div className="mobile-modal-minisel-panel" role="listbox">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`mobile-modal-minisel-opt ${o.value === value ? "active" : ""}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function EnkiMobileGenerateModal({
  isOpen,
  onClose,
  promptBody,
  setPromptBody,
  variables,
  onVariableChange,
  onAddVariable,
  onRemoveVariable,
  models,
  setModel,
  ratios,
  setRatio,
  priceFor,
  modelPriceLabel,
  onGenerate,
  onAutoFill,
  isAutoFilling = false,
  hideReleaseTab = false,
  referenceImages,
  onAddReferenceImages,
  onRemoveReferenceImage,
  onReorderReferenceImages,
  onPickNFT,
  nftImages,
  onRemoveNFT,
  onReorderNFTs,
  generateLabel,
  boost,
  onBoostChange,
  resolution: resolutionProp,
  setResolution: setResolutionProp,
  resolutionOptions,
  resultImages,
  isGenerating = false,
  requiredVariations,
  onRelease,
  title,
  setTitle,
  promptType,
  setPromptType,
  tags,
  onAddTag,
  onRemoveTag,
  price,
  setPrice,
  onToggleModel,
  onOpenPromptEditor,
  initialTab,
}: EnkiMobileGenerateModalProps) {
  const [activeTab, setActiveTab] = useState<"Generate" | "Release">(
    initialTab ?? "Generate"
  );
  const [releaseSection, setReleaseSection] = useState<"settings" | "prompt" | "verify">("settings");
  const [isDesktop, setIsDesktop] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  /* Release "Preferred Models" multi-select. When the parent wires a real
     multi-select handler (editor → onToggleModel) we defer to it; otherwise
     (feed launcher) we keep selection locally so it's still multiple-choice. */
  const [internalPrefModels, setInternalPrefModels] = useState<string[]>(() => models.selected);
  const [internalResolution, setInternalResolution] = useState("2K");
  const genResolution = resolutionProp ?? internalResolution;
  const setGenResolution = setResolutionProp ?? setInternalResolution;
  const [genCount, setGenCount] = useState("x 1");
  const prefModels = onToggleModel ? models.selected : internalPrefModels;
  const togglePrefModel = (id: string) => {
    if (onToggleModel) {
      onToggleModel(id);
      return;
    }
    setInternalPrefModels((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Land on the requested tab each time the sheet opens (e.g. the editor opens
  // straight into "Release" on mobile).
  useEffect(() => {
    if (isOpen && initialTab) setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  // Close on Escape while open
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);
  type Variation = {
    model: string;
    ratio: string;
    resolution: string;
    vars: { name: string; value: string }[];
    refs: string[];
    prompt: string;
  };
  const [variations, setVariations] = useState<Variation[]>([]);
  /* The prompt template the queued Verify images were composed from. While
     images exist, editing the prompt away from this triggers a reset warning. */
  const [committedPrompt, setCommittedPrompt] = useState<string | null>(null);
  const [verifyDialog, setVerifyDialog] = useState<
    null | { kind: "duplicate" } | { kind: "prompt-change"; pending: string }
  >(null);
  const [varTypes, setVarTypes] = useState<Record<string, "text" | "bool">>({});
  const refInputRef = useRef<HTMLInputElement>(null);
  /* Last known caret/selection inside the prompt textarea. Captured so the
     "+ Variable" button can turn a highlighted passage into a variable even
     after focus moves to the button. */
  const selectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  /* Card currently being dragged (deck id + index) so reordering only happens
     within the same deck (images stay with images, NFTs with NFTs). */
  const dragRef = useRef<{ deck: string; index: number } | null>(null);
  /* Where the dragged card would be inserted: `index` is the slot BETWEEN cards
     (0 = before first … n = after last). Drives the insertion line. */
  const [dropTarget, setDropTarget] = useState<{ deck: string; index: number } | null>(null);
  /* Which deck's stack popover is currently open (hover). Adding images only
     changes a count badge — the footer layout never grows/shifts. */
  const [openDeck, setOpenDeck] = useState<string | null>(null);

  /* User-controlled sheet height for the Quick Create (Generate-only) view.
     The sheet keeps a fixed height regardless of how many variables are added;
     the user resizes it by dragging the top handle. */
  const sheetElRef = useRef<HTMLDivElement>(null);
  const [sheetHeight, setSheetHeight] = useState<number | null>(null);
  const resizeStateRef = useRef<{ startY: number; startH: number } | null>(null);
  // Distinguishes a tap on the handle (→ minimise/close) from a real drag (→ resize).
  const handleMovedRef = useRef(false);
  // Closing plays a downward collapse animation, then unmounts.
  const [closing, setClosing] = useState(false);
  const requestClose = useCallback(() => {
    setClosing((c) => {
      if (c) return c;
      window.setTimeout(() => { setClosing(false); onClose(); }, 240);
      return true;
    });
  }, [onClose]);

  const onResizeMove = useCallback((e: PointerEvent) => {
    const st = resizeStateRef.current;
    if (!st) return;
    const delta = st.startY - e.clientY; // drag up → taller
    if (Math.abs(delta) > 6) handleMovedRef.current = true;
    const max = window.innerHeight * 0.88;
    setSheetHeight(Math.min(Math.max(st.startH + delta, 260), max));
  }, []);

  const onResizeEnd = useCallback(() => {
    resizeStateRef.current = null;
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", onResizeEnd);
    // A tap on the handle (no real drag) collapses the sheet down and closes it.
    if (!handleMovedRef.current) requestClose();
  }, [onResizeMove, requestClose]);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const h = sheetElRef.current?.getBoundingClientRect().height ?? sheetHeight ?? 0;
      handleMovedRef.current = false;
      resizeStateRef.current = { startY: e.clientY, startH: h };
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onResizeMove);
      window.addEventListener("pointerup", onResizeEnd);
    },
    [onResizeMove, onResizeEnd, sheetHeight]
  );

  // Seed a sensible default height the first time the Generate-only sheet opens.
  useEffect(() => {
    const fixed = hideReleaseTab || isDesktop;
    if (!isOpen || !fixed || sheetHeight != null || typeof window === "undefined") return;
    const ih = window.innerHeight;
    setSheetHeight(Math.round(Math.min(Math.max(ih * 0.55, 340), ih * 0.88)));
  }, [isOpen, hideReleaseTab, isDesktop, sheetHeight]);

  // Internal fallbacks for editor settings when the parent doesn't supply them (e.g. feed launcher)
  const [localTitle, setLocalTitle] = useState("");
  const [localType, setLocalType] = useState("free-prompt");
  const [localTags, setLocalTags] = useState<string[]>([]);
  const [localPrice, setLocalPrice] = useState(0);
  const priceVal = price ?? localPrice;
  /* The price field holds its own text. Bound to the number alone it could
     not hold "0", "0." or "0.0", so typing 0.05 left a price of 5. What is
     shown is that text while it stands for the price, and the price itself
     once that was set from outside. */
  const [priceText, setPriceText] = useState("");

  if (!isOpen) return null;

  const titleVal = title ?? localTitle;
  const onTitle = setTitle ?? setLocalTitle;
  const typeVal = promptType ?? localType;
  const onType = setPromptType ?? setLocalType;
  const tagsVal = tags ?? localTags;
  const addTagFn = onAddTag ?? ((t: string) => setLocalTags((p) => (p.includes(t) ? p : [...p, t])));
  const removeTagFn = onRemoveTag ?? ((t: string) => setLocalTags((p) => p.filter((x) => x !== t)));
  const onPrice = setPrice ?? setLocalPrice;
  const showReferenceImages = typeof onAddReferenceImages === "function";
  // Web has no Release flow — it offers a "Prompt editor" button instead.
  const showRelease = !hideReleaseTab && !isDesktop;
  const tab: "Generate" | "Release" = showRelease ? activeTab : "Generate";
  /* The Quick Create (Generate-only) sheet uses a fixed, user-resizable height
     so it never grows with the number of variables. */
  const fixedSheet = !showRelease;
  const reqVars = requiredVariations ?? 4;
  const variationsDone = variations.length;
  const releaseReady = variationsDone >= reqVars;

  /* The price shown is the parent's server quote for exactly the number of
     images the button generates (Kev, 2026-10-02: "ich brauche safe überall
     den server-quote"). Quick Create used to compute it here with a 5% fee
     against the server's 10%, and the count multiplied a price while one
     image was generated. */
  const genCountNum = Math.max(1, parseInt(genCount.replace(/\D/g, ""), 10) || 1);

  /* Declared to the dice under the SAME ids onVariableChange uses, so a rolled
     value lands exactly in the field the user would have typed into. Both
     parents (editor + feed launcher) store plain strings, so everything that
     is not explicitly a checkbox/image rolls as free text. */
  const diceVariables: DiceVariable[] = variables.map((v) => ({
    id: v.id,
    name: v.name,
    label: v.label && v.label !== v.name ? v.label : undefined,
    type: v.type === "checkbox" || v.type === "image" ? v.type : "text",
  }));

  const applyDiceValues = (values: Record<string, DiceValue>) => {
    if (!onVariableChange) return;
    // Iterating our own variables merges ONLY known ids; fields the dice did
    // not return keep whatever the user already entered.
    for (const v of variables) {
      const val = values[v.id];
      if (val === undefined) continue;
      // Inputs hold strings; "Yes"/"No" is this file's own boolean idiom.
      onVariableChange(
        v.id,
        typeof val === "boolean" ? (val ? "Yes" : "No") : Array.isArray(val) ? val.join(", ") : String(val)
      );
    }
  };

  const snapshotVars = () =>
    variables.map((v) => ({
      name: v.name,
      value: String((v.values && v.values[0]) || v.defaultValue || ""),
    }));
  const currentRefs = () => referenceImages ?? [];

  /* Signature of a "pack input": variable values + reference images. Used to
     detect a redundant pack (nothing changed since an existing image). */
  const packSig = (vars: { name: string; value: string }[], refs: string[]) =>
    JSON.stringify({ vars: vars.map((v) => `${v.name}=${v.value}`), refs });

  const commitPack = () => {
    const vars = snapshotVars();
    const refs = currentRefs();
    setVariations((prev) => [
      ...prev,
      {
        model: models.selected[0] || "",
        ratio: ratios.selected || "1:1",
        resolution: "2K",
        vars,
        refs,
        prompt: promptBody,
      },
    ]);
    setCommittedPrompt(promptBody);
  };

  const packToVerify = () => {
    const sig = packSig(snapshotVars(), currentRefs());
    const isDuplicate = variations.some((v) => packSig(v.vars, v.refs) === sig);
    if (isDuplicate) {
      setVerifyDialog({ kind: "duplicate" });
      return;
    }
    commitPack();
  };

  const updateVariation = (i: number, patch: Partial<Variation>) =>
    setVariations((v) => v.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeVariation = (i: number) =>
    setVariations((v) => {
      const next = v.filter((_, idx) => idx !== i);
      if (next.length === 0) setCommittedPrompt(null);
      return next;
    });

  /* Editing the prompt template after images are queued changes the whole
     composition → confirm. Reset wipes Verify; cancel reverts the prompt. */
  const handleReleasePromptChange = (val: string) => {
    if (!setPromptBody) return;
    if (variations.length > 0 && committedPrompt !== null && val !== committedPrompt) {
      setVerifyDialog({ kind: "prompt-change", pending: val });
      return;
    }
    setPromptBody(val);
  };

  /* "+ Variable" behaviour:
     - With a highlighted passage → wrap EVERY identical passage in [brackets]
       so they all become the same variable at once.
     - With no selection → fall back to the parent's add-variable action. */
  const handleAddVariable = () => {
    const sel = selectionRef.current;
    if (setPromptBody && sel.end > sel.start) {
      const selected = promptBody.slice(sel.start, sel.end).trim();
      if (selected && !selected.includes("[") && !selected.includes("]")) {
        setPromptBody(promptBody.split(selected).join(`[${selected}]`));
        selectionRef.current = { start: 0, end: 0 };
        return;
      }
    }
    onAddVariable?.();
  };

  /* The stack popover: opens UPWARD on hover as a held-together fanned deck.
     Cards overlap and the overlap tightens as the count grows (so the stack
     stays compact instead of spreading into a long scroll). Hovering a card
     lifts it to the front; dragging reorders. Rendered absolutely so it never
     affects the footer layout. */
  const POP_CARD_W = 58;
  const POP_PAD = 10; // must match .mobile-modal-ref-pop horizontal padding
  const renderDeckPopover = (
    deck: string,
    items: string[],
    onRemove?: (i: number) => void,
    onReorder?: (from: number, to: number) => void
  ) => {
    const n = items.length;
    // Distance between consecutive cards; the more cards, the tighter the fan
    // (kept within ~320px total so the stack holds together, no scrolling).
    const step =
      n > 1
        ? Math.max(14, Math.min(POP_CARD_W - 8, (320 - POP_CARD_W) / (n - 1)))
        : POP_CARD_W;
    return (
      <div className="mobile-modal-ref-pop">
        {/* Insertion line — shows exactly BETWEEN which cards the drop lands. */}
        {dropTarget?.deck === deck && (
          <div
            className="mobile-modal-ref-insert"
            style={{
              left:
                POP_PAD +
                (dropTarget.index < n
                  ? dropTarget.index * step
                  : (n - 1) * step + POP_CARD_W),
            }}
          />
        )}
        {items.map((src, i) => {
          const key = `${deck}:${i}`;
          return (
            <div
              key={key}
              className="mobile-modal-ref-popcard"
              style={{ marginLeft: i === 0 ? 0 : step - POP_CARD_W, zIndex: i + 1 }}
              draggable
              onDragStart={(e) => {
                dragRef.current = { deck, index: i };
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragRef.current?.deck !== deck) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = e.currentTarget.getBoundingClientRect();
                const after = e.clientX > rect.left + rect.width / 2;
                const di = after ? i + 1 : i;
                if (dropTarget?.index !== di || dropTarget?.deck !== deck) {
                  setDropTarget({ deck, index: di });
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const d = dragRef.current;
                if (d && d.deck === deck && dropTarget) {
                  const to = dropTarget.index > d.index ? dropTarget.index - 1 : dropTarget.index;
                  if (to !== d.index) onReorder?.(d.index, to);
                }
                dragRef.current = null;
                setDropTarget(null);
              }}
              onDragEnd={() => {
                dragRef.current = null;
                setDropTarget(null);
              }}
              title="Drag to reorder"
            >
              <span className="mobile-modal-ref-popcard-idx">{i + 1}</span>
              <img src={src} alt={`${deck} ${i + 1}`} draggable={false} />
              {onRemove && (
                <button
                  type="button"
                  className="mobile-modal-ref-card-remove"
                  onClick={() => onRemove(i)}
                  aria-label="Remove"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // Helper to render prompt with pills
  const renderPromptWithPills = () => {
    // Only detect [square bracket] variables as pills
    const parts = promptBody.split(/(\[[a-z_0-9]+\])/gi);
    return (
      <div className="mobile-modal-prompt-text">
        {parts.map((part, index) => {
          if (part.match(/^\[[a-z_0-9]+\]$/i)) {
            return (
              <span key={index} className="mobile-modal-pill">
                {part}
              </span>
            );
          }
          return <span key={index}>{part}</span>;
        })}
      </div>
    );
  };

  return (
      <div className={`mobile-modal-overlay ${closing ? "mobile-modal-overlay--closing" : ""}`} onClick={() => requestClose()}>
      {/* Generated results — floated ABOVE the sheet */}
      {((resultImages && resultImages.length > 0) || isGenerating) && (
        <div className="mobile-modal-results" onClick={(e) => e.stopPropagation()}>
          {isGenerating && (
            <div className="mobile-modal-result-thumb mobile-modal-result-thumb--loading">
              <Sparkles size={18} />
            </div>
          )}
          {(resultImages ?? []).map((src, i) => (
            <a
              key={i}
              href={src}
              target="_blank"
              rel="noreferrer"
              className="mobile-modal-result-thumb"
            >
              <img src={src} alt={`Generated ${i + 1}`} />
            </a>
          ))}
        </div>
      )}
      <div
        ref={sheetElRef}
        className={`mobile-modal-sheet ${fixedSheet ? "mobile-modal-sheet--fixed" : ""} ${closing ? "mobile-modal-sheet--closing" : ""}`}
        style={fixedSheet && sheetHeight ? { height: `${sheetHeight}px` } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle — drag up/down to resize (Quick Create), else click to close */}
        <div
          className="mobile-modal-handle"
          role={fixedSheet ? "separator" : "button"}
          aria-label={fixedSheet ? "Resize" : "Close"}
          onPointerDown={fixedSheet ? onHandlePointerDown : undefined}
          onClick={fixedSheet ? undefined : () => requestClose()}
          style={fixedSheet ? { cursor: "ns-resize", touchAction: "none" } : undefined}
        ></div>

        {/* Header */}
        <div className="mobile-modal-header">
          {/* Tabs hidden on desktop (Generate-only there) */}
          <div className="mobile-modal-tabs">
            {!isDesktop && (
              <>
                <button
                  className={`mobile-modal-tab ${tab === "Generate" ? "active" : ""}`}
                  onClick={() => setActiveTab("Generate")}
                >
                  Generate
                </button>
                {showRelease && (
                  <button
                    className={`mobile-modal-tab ${tab === "Release" ? "active" : ""}`}
                    onClick={() => setActiveTab("Release")}
                  >
                    Release
                  </button>
                )}
              </>
            )}
          </div>
          <div className="mobile-modal-header-actions">
            <button className="mobile-modal-close" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="mobile-modal-content">
          {tab === "Generate" ? (
            <>
              {/* Generate Tab Content */}
              {/* Prompt + Variables (prompt left, variables appear on the right) */}
              <div className="mobile-modal-section">
                <div className="mobile-modal-gen-prompthead">
                  <div className="mobile-modal-prompthead-actions">
                    <label className="mobile-modal-label" style={{ margin: 0 }}>PROMPT</label>
                    {onAddVariable && (
                      <button className="mobile-modal-add-var-btn" onClick={handleAddVariable}>
                        + Variable
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    className="mobile-modal-close mobile-modal-prompthead-close"
                    onClick={onClose}
                    aria-label="Close"
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="mobile-modal-gen-row">
                  <div className="mobile-modal-gen-promptcol">
                    {setPromptBody ? (
                      <HighlightedPromptInput
                        value={promptBody}
                        onChange={setPromptBody}
                        placeholder="Describe your image…"
                        variables={variables}
                        onSelectionChange={(s, e) => {
                          selectionRef.current = { start: s, end: e };
                        }}
                      />
                    ) : (
                      <div className="mobile-modal-prompt-box">
                        {renderPromptWithPills()}
                      </div>
                    )}
                  </div>
                  {variables.length > 0 && (
                    <div className="mobile-modal-gen-varscol">
                      {variables.map((variable, vi) => {
                        const c = getVariableColors(
                          typeof variable.colorIndex === "number" ? variable.colorIndex : vi
                        );
                        return (
                        <div
                          key={variable.id}
                          className="mobile-modal-var-row"
                          style={{ background: c.bg, border: `1px solid ${c.border}` }}
                        >
                          <span
                            className="mobile-modal-var-name"
                            style={{ color: c.text, borderRightColor: c.border }}
                          >
                            {variable.name}
                          </span>
                          <input
                            type="text"
                            className="mobile-modal-var-input"
                            value={variable.values[0] || (variable.defaultValue as string)}
                            onChange={(e) => onVariableChange && onVariableChange(variable.id, e.target.value)}
                            placeholder={`Enter ${variable.name}...`}
                          />
                          {onRemoveVariable && (
                            <button
                              type="button"
                              className="mobile-modal-var-remove"
                              aria-label={`Remove ${variable.name}`}
                              onClick={() => onRemoveVariable(variable.name)}
                            >
                              <X size={12} />
                            </button>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

            </>
          ) : (
            <>
              {/* ── Section: Settings (mirrors the /editor left column) ── */}
              {releaseSection === "settings" && (
                <>
                  <div className="mobile-modal-section">
                    <label className="mobile-modal-label">PROMPT TITLE</label>
                    <input
                      type="text"
                      className="mobile-modal-var-manager-input"
                      placeholder="Untitled Prompt"
                      value={titleVal}
                      onChange={(e) => onTitle(e.target.value)}
                    />
                  </div>

                  <div className="mobile-modal-section">
                    <label className="mobile-modal-label">DISPLAY MODE</label>
                    <div className="mobile-modal-segment">
                      <button
                        type="button"
                        className={`mobile-modal-segment-btn ${typeVal === "free-prompt" ? "active" : ""}`}
                        onClick={() => onType("free-prompt")}
                      >
                        Free prompt
                      </button>
                      <button
                        type="button"
                        className={`mobile-modal-segment-btn ${typeVal === "premium-prompt" ? "active" : ""}`}
                        onClick={() => onType("premium-prompt")}
                      >
                        Premium prompt
                      </button>
                    </div>
                  </div>

                  <div className="mobile-modal-settings-2col">
                    <div className="mobile-modal-section" style={{ flex: 1 }}>
                      <label className="mobile-modal-label">CATEGORY</label>
                      <select
                        className="mobile-modal-select mobile-modal-select--full"
                        value={(tagsVal[0] || "").toLowerCase()}
                        onChange={(e) => {
                          const val = e.target.value;
                          tagsVal.forEach((t) => removeTagFn(t));
                          if (val) addTagFn(val);
                        }}
                      >
                        <option value="">Theme…</option>
                        {CATEGORY_OPTIONS.map((c) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                    </div>

                    <div className="mobile-modal-section" style={{ flex: 1 }}>
                      <label className="mobile-modal-label">PREFERRED RATIO</label>
                      <select
                        className="mobile-modal-select mobile-modal-select--full"
                        value={ratios.selected}
                        onChange={(e) => setRatio && setRatio(e.target.value)}
                      >
                        {ratios.available.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mobile-modal-section">
                    <label className="mobile-modal-label">PREFERRED MODELS · {prefModels.length}</label>
                    <div className="mobile-modal-multiselect">
                      <button
                        type="button"
                        className="mobile-modal-select mobile-modal-select--full mobile-modal-multiselect-trigger"
                        onClick={() => setModelOpen((o) => !o)}
                      >
                        {prefModels.length > 0
                          ? models.available.filter((m) => prefModels.includes(m.id)).map((m) => m.name).join(", ")
                          : "Select models…"}
                      </button>
                      {modelOpen && (
                        <div className="mobile-modal-multiselect-panel">
                          {models.available.map((m) => {
                            const active = prefModels.includes(m.id);
                            return (
                              <button
                                key={m.id}
                                type="button"
                                className="mobile-modal-multiselect-opt"
                                onClick={() => togglePrefModel(m.id)}
                              >
                                <span className={`mobile-modal-checkbox ${active ? "checked" : ""}`}>{active ? "✓" : ""}</span>
                                <span className="mobile-modal-multiselect-name">{m.name}</span>
                                {modelPriceLabel?.(m.id) && (
                                  <span className="mobile-modal-model-card-price">{modelPriceLabel(m.id)}</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mobile-modal-section">
                    <label className="mobile-modal-label">PRICING</label>
                    {typeVal === "premium-prompt" ? (
                      <div className="mobile-modal-price-input-wrap">
                        <span className="mobile-modal-price-input-prefix">$</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          className="mobile-modal-price-input"
                          placeholder="0.0000"
                          value={priceTextFor(priceText, priceVal)}
                          onChange={(e) => {
                            const text = priceInputText(e.target.value);
                            setPriceText(text);
                            onPrice(priceOf(text));
                          }}
                        />
                        <span className="mobile-modal-price-input-suffix">USDC / render</span>
                      </div>
                    ) : (
                      <p className="mobile-modal-hint">Free prompts have no per-render price. Switch to Premium to set one.</p>
                    )}
                  </div>
                </>
              )}

              {/* ── Section: Prompt + Variables ── */}
              {releaseSection === "prompt" && (
                <>
                  <div className="mobile-modal-section">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <label className="mobile-modal-label" style={{ margin: 0 }}>PROMPT TEMPLATE</label>
                      <button className="mobile-modal-add-var-btn" onClick={onAddVariable}>
                        + Variable
                      </button>
                    </div>
                    {setPromptBody ? (
                      <HighlightedPromptInput
                        value={promptBody}
                        onChange={handleReleasePromptChange}
                        placeholder="Describe your image…"
                        variables={variables}
                      />
                    ) : (
                      <div className="mobile-modal-prompt-box">
                        <div className="mobile-modal-dashed-prompt">
                          {variables.map((v, i) => (
                            <span key={i} className="mobile-modal-dashed-pill">[{v.name}]</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {showReferenceImages && (
                    <div className="mobile-modal-section">
                      <label className="mobile-modal-label">REFERENCE IMAGES · optional</label>
                      <div className="mobile-modal-ref-grid">
                        <input
                          ref={refInputRef}
                          type="file"
                          accept="image/*"
                          multiple
                          style={{ display: "none" }}
                          onChange={(e) => {
                            if (e.target.files && e.target.files.length > 0) {
                              onAddReferenceImages?.(e.target.files);
                            }
                            e.target.value = "";
                          }}
                        />
                        <button
                          type="button"
                          className="mobile-modal-ref-add"
                          onClick={() => refInputRef.current?.click()}
                          aria-label="Add reference image"
                        >
                          <Plus size={16} />
                        </button>
                        {(referenceImages ?? []).map((src, i) => (
                          <div key={i} className="mobile-modal-ref-thumb">
                            <img src={src} alt={`Reference ${i + 1}`} />
                            <button
                              type="button"
                              className="mobile-modal-ref-remove"
                              onClick={() => onRemoveReferenceImage?.(i)}
                              aria-label="Remove reference image"
                            >
                              <X size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mobile-modal-section">
                    <label className="mobile-modal-label">VARIABLES · {variables.length}</label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {variables.map((variable) => {
                        const vType = varTypes[variable.id] ?? "text";
                        return (
                          <div key={variable.id} className="mobile-modal-var-manager-card">
                            <div className="mobile-modal-var-manager-header">
                              <span className="mobile-modal-dashed-name">[{variable.name}]</span>
                              <button
                                className="mobile-modal-close"
                                style={{ width: 24, height: 24, border: "none", background: "#F2EFEA" }}
                                onClick={() => onRemoveVariable && onRemoveVariable(variable.name)}
                              >
                                <X size={14} color="#8A7F72" />
                              </button>
                            </div>
                            <div className="mobile-modal-var-types">
                              <button
                                type="button"
                                className={`mobile-modal-var-type ${vType === "text" ? "active" : ""}`}
                                onClick={() => setVarTypes((p) => ({ ...p, [variable.id]: "text" }))}
                              >
                                Text
                              </button>
                              <button
                                type="button"
                                className={`mobile-modal-var-type ${vType === "bool" ? "active" : ""}`}
                                onClick={() => setVarTypes((p) => ({ ...p, [variable.id]: "bool" }))}
                              >
                                Yes / No
                              </button>
                            </div>
                            {vType === "bool" ? (
                              <div className="mobile-modal-yesno">
                                <button
                                  type="button"
                                  className={`mobile-modal-yesno-btn ${String(variable.defaultValue) === "Yes" ? "active" : ""}`}
                                  onClick={() => onVariableChange && onVariableChange(variable.id, "Yes")}
                                >
                                  Yes
                                </button>
                                <button
                                  type="button"
                                  className={`mobile-modal-yesno-btn ${String(variable.defaultValue) === "No" ? "active" : ""}`}
                                  onClick={() => onVariableChange && onVariableChange(variable.id, "No")}
                                >
                                  No
                                </button>
                              </div>
                            ) : (
                              <input
                                type="text"
                                className="mobile-modal-var-manager-input"
                                placeholder="Comma-separated options: option a, option b..."
                                value={variable.defaultValue as string}
                                onChange={(e) => onVariableChange && onVariableChange(variable.id, e.target.value)}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Push the configured prompt into Verify as an image to render.
                      Stay on this section; the button goes green once enough
                      variations are queued. */}
                  <button
                    type="button"
                    className={`mobile-modal-verify-gen ${releaseReady ? "is-ready" : ""}`}
                    onClick={packToVerify}
                  >
                    {releaseReady ? <CheckCircle2 size={14} /> : <Plus size={14} />}
                    {releaseReady
                      ? `Ready (${variationsDone}/${reqVars}) — pack more`
                      : `Pack to Verify (${variationsDone}/${reqVars})`}
                  </button>
                </>
              )}

              {/* ── Section: Verify + Generate (per-image model / aspect / resolution) ── */}
              {releaseSection === "verify" && (
                <div className="mobile-modal-section">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <label className="mobile-modal-label" style={{ margin: 0 }}>VERIFY · {variationsDone}/{reqVars}</label>
                    <span
                      className="mobile-modal-verify-check"
                      title={releaseReady ? "Ready to release" : `${reqVars - variationsDone} more image${reqVars - variationsDone !== 1 ? "s" : ""} required`}
                    >
                      <CheckCircle2 size={18} style={{ color: releaseReady ? "#1E9E5A" : "#D8D0C4" }} />
                    </span>
                  </div>

                  {variations.length === 0 && (
                    <p className="mobile-modal-hint">No images yet — configure Prompt + Variables and use “Pack to Verify”.</p>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
                    {variations.map((v, i) => (
                      <div key={i} className="mobile-modal-varimg-card">
                        <div className="mobile-modal-varimg-head">
                          <span className="mobile-modal-varimg-title">Image {i + 1}</span>
                          <button
                            type="button"
                            className="mobile-modal-close"
                            style={{ width: 24, height: 24, border: "none", background: "#F2EFEA" }}
                            onClick={() => removeVariation(i)}
                          >
                            <X size={14} color="#8A7F72" />
                          </button>
                        </div>
                        {v.refs.length > 0 && (
                          <div className="mobile-modal-varimg-refs">
                            {v.refs.map((src, k) => (
                              <div key={k} className="mobile-modal-varimg-ref">
                                <img src={src} alt={`Reference ${k + 1}`} />
                              </div>
                            ))}
                          </div>
                        )}
                        {v.vars.length > 0 && (
                          <div className="mobile-modal-varimg-vars">
                            {v.vars.map((kv, k) => (
                              <div key={k} className="mobile-modal-varimg-var">
                                <span className="k">{kv.name}</span>
                                <span className="v">{kv.value || "—"}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <button type="button" className="mobile-modal-varimg-gen" onClick={() => onGenerate(1)}>
                          <Sparkles size={13} />
                          Generate this image
                        </button>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    className="mobile-modal-generate-btn"
                    style={{ width: "100%", marginTop: 14, ...(releaseReady ? { background: "#1E9E5A" } : { opacity: 0.45 }) }}
                    disabled={!releaseReady || !onRelease}
                    onClick={onRelease}
                  >
                    <Sparkles size={14} style={{ fill: "white" }} />
                    Release prompt
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className={`mobile-modal-footer ${tab === "Release" ? "mobile-modal-footer--nav" : ""}`}>
          {tab === "Generate" ? (
            <div className="mobile-modal-footer-actions">
              {/* [model · ratio · size · count · pay] — packed left of Generate.
                  Custom dropdowns open upward so the list stays inside the sheet. */}
              <div className="mobile-modal-gen-left">
                {showReferenceImages && (
                  <div className="mobile-modal-ref-inline">
                    <input
                      ref={refInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      style={{ display: "none" }}
                      onChange={(e) => {
                        if (e.target.files && e.target.files.length > 0) {
                          onAddReferenceImages?.(e.target.files);
                        }
                        e.target.value = "";
                      }}
                    />

                    {/* Images deck — fixed-size button with a count badge; the
                        stack opens upward on hover. */}
                    <div
                      className="mobile-modal-ref-deck"
                      onMouseEnter={() => {
                        if ((referenceImages ?? []).length) setOpenDeck("img");
                      }}
                      onMouseLeave={() => {
                        setOpenDeck((p) => (p === "img" ? null : p));
                        setDropTarget(null);
                      }}
                    >
                      <button
                        type="button"
                        className="mobile-modal-ref-btn"
                        onClick={() => refInputRef.current?.click()}
                        title="Upload an image"
                        aria-label="Upload an image"
                      >
                        <Plus size={13} />
                        <ImageIcon size={15} />
                      </button>
                      {(referenceImages ?? []).length > 0 && (
                        <div
                          className="mobile-modal-ref-chip"
                          title={`${(referenceImages ?? []).length} image(s) — hover to reorder`}
                        >
                          <img src={(referenceImages ?? [])[0]} alt="Uploaded" />
                          <span className="mobile-modal-ref-chip-count">{(referenceImages ?? []).length}</span>
                        </div>
                      )}
                      {openDeck === "img" && (referenceImages ?? []).length > 0 &&
                        renderDeckPopover(
                          "img",
                          referenceImages ?? [],
                          onRemoveReferenceImage,
                          onReorderReferenceImages
                        )}
                    </div>

                    {/* NFTs deck */}
                    {(onPickNFT || (nftImages ?? []).length > 0) && (
                      <div
                        className="mobile-modal-ref-deck"
                        onMouseEnter={() => {
                          if ((nftImages ?? []).length) setOpenDeck("nft");
                        }}
                        onMouseLeave={() => {
                          setOpenDeck((p) => (p === "nft" ? null : p));
                          setDropTarget(null);
                        }}
                      >
                        {onPickNFT && (
                          <button
                            type="button"
                            className="mobile-modal-ref-btn"
                            onClick={() => onPickNFT()}
                            title="Pick an NFT from your wallet"
                            aria-label="Pick an NFT"
                          >
                            <Plus size={13} />
                            NFT
                          </button>
                        )}
                        {(nftImages ?? []).length > 0 && (
                          <div
                            className="mobile-modal-ref-chip"
                            title={`${(nftImages ?? []).length} NFT(s) — hover to reorder`}
                          >
                            <img src={(nftImages ?? [])[0]} alt="NFT" />
                            <span className="mobile-modal-ref-chip-count">{(nftImages ?? []).length}</span>
                          </div>
                        )}
                        {openDeck === "nft" && (nftImages ?? []).length > 0 &&
                          renderDeckPopover(
                            "nft",
                            nftImages ?? [],
                            onRemoveNFT,
                            onReorderNFTs
                          )}
                      </div>
                    )}
                  </div>
                )}
                {/* Sized to the LONGEST model name and pinned there: a
                    trigger that resizes with the selection shoves every
                    control beside it (Kev, 2026-08-24). ~7.2px/char at the
                    12px trigger font, plus padding and the chevron. */}
                <MiniSelect
                  title="Model"
                  value={models.selected[0] || ""}
                  options={models.available.map((m) => ({ value: m.id, label: m.name }))}
                  onChange={(v) => setModel && setModel(v)}
                  fixedWidth={Math.min(230, Math.round(Math.max(8, ...models.available.map((m) => String(m.name ?? "").length)) * 7.2) + 34)}
                />
                <MiniSelect
                  title="Aspect ratio"
                  icon={<Ratio size={14} style={{ color: "#8A7F72", flexShrink: 0 }} aria-label="Aspect ratio" />}
                  value={ratios.selected}
                  options={ratios.available.map((r) => ({ value: r, label: r }))}
                  onChange={(v) => setRatio && setRatio(v)}
                />
                <MiniSelect
                  title="Resolution"
                  icon={<Maximize2 size={14} style={{ color: "#8A7F72", flexShrink: 0 }} aria-label="Resolution" />}
                  value={genResolution}
                  options={resolutionOptions ?? [{ value: "2K", label: "2K" }, { value: "4K", label: "4K" }]}
                  onChange={setGenResolution}
                />
                {/* A dropdown like every other control here (Kev,
                    2026-08-23) — "fully visible" means the OPEN list shows
                    all eight without scrolling, which the desktop panel rule
                    guarantees. */}
                <MiniSelect
                  title="Generations"
                  icon={<Copy size={14} style={{ color: "#8A7F72", flexShrink: 0 }} aria-label="Generations" />}
                  value={genCount}
                  options={[1, 2, 3, 4, 5, 6, 7, 8].map((qn) => ({ value: `x ${qn}`, label: `x ${qn}` }))}
                  onChange={setGenCount}
                />
              </div>
              <div className="mobile-modal-pay-inline">
                <span className="mobile-modal-pay-inline-price">{priceFor(genCountNum)}</span>
              </div>
              {onBoostChange && (
                <BoostToggle boost={!!boost} onChange={onBoostChange} disabled={isGenerating} />
              )}
              {/* 🎲 — invents one coherent set of variable values. Without an
                  onVariableChange there is nowhere to put a roll, so no dice.
                  setPromptBody absent = locked paid (vars-only) prompt: its
                  body must NOT ride along to the dice model on a buyer's
                  behalf, so the roll then sees only the variable declarations. */}
              {onVariableChange && (
                <DiceButton
                  variables={diceVariables}
                  context={setPromptBody ? promptBody : undefined}
                  headers={sessionAuthHeaders()}
                  onValues={applyDiceValues}
                  disabled={isGenerating}
                  size={14}
                />
              )}
              <button className="mobile-modal-generate-btn" onClick={() => onGenerate(genCountNum)} disabled={isGenerating}>
                <Sparkles size={13} style={{ fill: "white" }} />
                {generateLabel || "Generate"}
              </button>
            </div>
          ) : (
            /* Ultra-bottom menu: full-width section nav flush with the screen edge */
            <div className="mobile-modal-bottomnav">
              <button
                type="button"
                className={`mobile-modal-bottomnav-btn ${releaseSection === "settings" ? "active" : ""}`}
                onClick={() => setReleaseSection("settings")}
              >
                <Settings size={18} />
                <span>Settings</span>
              </button>
              <button
                type="button"
                className={`mobile-modal-bottomnav-btn ${releaseSection === "prompt" ? "active" : ""}`}
                onClick={() => setReleaseSection("prompt")}
              >
                <FileText size={18} />
                <span>Prompt + Variables</span>
              </button>
              <button
                type="button"
                className={`mobile-modal-bottomnav-btn ${releaseSection === "verify" ? "active" : ""}`}
                onClick={() => setReleaseSection("verify")}
              >
                <CheckCircle2 size={18} style={{ color: releaseReady ? "#1E9E5A" : undefined }} />
                <span>Verify + Generate</span>
                {releaseReady && <span className="mobile-modal-bottomnav-dot" />}
              </button>
            </div>
          )}
        </div>

        {/* Verify-flow confirmation dialogs */}
        {verifyDialog && (
          <div className="mobile-modal-confirm" onClick={() => setVerifyDialog(null)}>
            <div className="mobile-modal-confirm-card" onClick={(e) => e.stopPropagation()}>
              {verifyDialog.kind === "duplicate" ? (
                <>
                  <h4 className="mobile-modal-confirm-title">Identical image already queued</h4>
                  <p className="mobile-modal-confirm-text">
                    Nothing changed in the prompt, variables or reference images
                    since an image already in Verify. Add it anyway?
                  </p>
                  <div className="mobile-modal-confirm-actions">
                    <button
                      type="button"
                      className="mobile-modal-confirm-btn"
                      onClick={() => setVerifyDialog(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="mobile-modal-confirm-btn mobile-modal-confirm-btn--primary"
                      onClick={() => {
                        commitPack();
                        setVerifyDialog(null);
                      }}
                    >
                      Add anyway
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h4 className="mobile-modal-confirm-title">Reset the Verify section?</h4>
                  <p className="mobile-modal-confirm-text">
                    Changing the prompt changes the entire image composition.
                    Resetting removes all {variations.length} queued image
                    {variations.length !== 1 ? "s" : ""}. Keep them and revert the
                    prompt instead?
                  </p>
                  <div className="mobile-modal-confirm-actions">
                    <button
                      type="button"
                      className="mobile-modal-confirm-btn"
                      onClick={() => {
                        // Refuse: revert the prompt to its committed state, keep images.
                        if (committedPrompt !== null) setPromptBody?.(committedPrompt);
                        setVerifyDialog(null);
                      }}
                    >
                      Keep images
                    </button>
                    <button
                      type="button"
                      className="mobile-modal-confirm-btn mobile-modal-confirm-btn--danger"
                      onClick={() => {
                        // Agree: wipe Verify and accept the new prompt.
                        const pending = verifyDialog.pending;
                        setVariations([]);
                        setCommittedPrompt(null);
                        setPromptBody?.(pending);
                        setVerifyDialog(null);
                      }}
                    >
                      Reset Verify
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
