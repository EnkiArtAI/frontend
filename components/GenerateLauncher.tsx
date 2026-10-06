"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useToast } from "@/hooks/use-toast";
import { useModelLimits } from "@/hooks/useModelLimits";
import PromptEngagement from "@/components/PromptEngagement";
import { addCreation } from "@/lib/creations";
import EnkiMobileGenerateModal from "@/components/EnkiMobileGenerateModal";
import type { EnkiPrompt } from "@/lib/enkiPromptAdapter";
import { runGeneration } from "@/lib/generation/run-generation";
import { usePaymentSigner } from "@/hooks/usePaymentSigner";
import { useServerQuotes, quoteLabel } from "@/hooks/useServerQuotes";
import { useGenerationCore } from "@/hooks/useGenerationCore";
import NftPickerModal from "@/components/enki/NftPickerModal";
import { useReferenceReads, REFS_LOADING } from "@/hooks/useReferenceReads";

/* No literals: models, ratios, tiers, prices, the boost lever and the NFT
   reference limit all come from useGenerationCore — the one global source
   every generate surface reads (Kev, 2026-08-22). The old GL_MODELS pair
   (invented $0.10, no Flux) and the five-ratio list were exactly the drift
   that rule exists to end. */

/**
 * GenerateLauncher — the unified "Generate" entry point (ported from pr45) that
 * replaces the old EnkiQuickCreate pill/panel. The launch pill opens the shared
 * EnkiMobileGenerateModal (Generate-only) on all viewports, with
 * reference-image upload + NFT support.
 *
 * Generates the selected model through runGeneration: the free model on the
 * free route, every other model paid through a payment intent. It used to
 * post everything to /api/generate-free, so Nano Banana Pro, its price and
 * its 4K tier were shown and Flux rendered.
 *
 * `seedPrompt` lets the explore feed open this same modal pre-filled with a
 * clicked prompt: free prompts (visibility "full") expose the full editable
 * body; paid prompts (visibility "vars-only") lock the body and surface only
 * the creator's exposed variables. When `seedPrompt` is null the launcher
 * behaves as the blank floating "Generate" entry point.
 */
type GenerateLauncherProps = {
  seedPrompt?: EnkiPrompt | null;
  onSeedClose?: () => void;
};

export default function GenerateLauncher({ seedPrompt = null, onSeedClose }: GenerateLauncherProps) {
  const router = useRouter();
  const { toast } = useToast();
  const account = useActiveAccount();
  const { publicKey: solanaPublicKey } = useWallet();
  const { address: cdpAddress } = useCdpAddress();
  const userKey = useMemo(
    () => account?.address ?? solanaPublicKey?.toBase58() ?? cdpAddress ?? null,
    [account?.address, solanaPublicKey, cdpAddress]
  );

  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const { loading: refsLoading, read: readRef } = useReferenceReads();
  // Same model on a priority host — faster, dearer, identical image.
  const [boost, setBoost] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [valueByToken, setValueByToken] = useState<Record<string, string>>({});
  // No preselected model: the user picks (Kev, 2026-10-02: "IMMER DAS AUSGEWÄHLTE").
  const [model, setModel] = useState("");
  const signPayment = usePaymentSigner();
  const core = useGenerationCore(model);
  const [resolution, setResolution] = useState("2K");
  const [nftPickerOpen, setNftPickerOpen] = useState(false);
  // Per-model limits (max reference images, allowed filetypes) from the DB.
  const modelLimits = useModelLimits(model);
  const [ratio, setRatio] = useState("1:1");
  // A model switch must never leave a ratio or tier the new model lacks.
  useEffect(() => { if (!core.loading && !core.ratios.includes(ratio)) setRatio(core.clampRatio(ratio)); }, [core, ratio]);
  useEffect(() => { if (!core.loading && core.clampTier(resolution) !== resolution) setResolution(core.clampTier(resolution)); }, [core, resolution]);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [nftImages, setNftImages] = useState<string[]>([]);

  /* Every price shown is a server quote (Kev, 2026-10-02: "ich brauche safe
     überall den server-quote"): the current settings first, then each tier
     for the resolution options. */
  const asTier = (t: string) => (t === "1K" || t === "2K" || t === "4K" ? t : null);
  const refCount = referenceImages.length + nftImages.length;
  const paidEntry = core.entry && !core.entry.free ? core.entry : null;
  const quoteTiers = core.tiers.map((t) => t.tier);
  const quotes = useServerQuotes(
    paidEntry
      ? [resolution, ...quoteTiers].flatMap((t) => {
          const tier = asTier(t);
          return tier ? [{ modelId: paidEntry.id, resolution: tier, boost: core.boostAvailable && boost, referenceImageCount: refCount }] : [];
        })
      : [],
  );
  const priceFor = (n: number) => (core.entry?.free ? "Free" : !core.entry ? "" : quoteLabel(quotes[0], n) ?? "…");
  const tierLabel = (i: number) => (core.entry?.free ? "Free" : quoteLabel(quotes[i + 1]));
  const [results, setResults] = useState<string[]>([]);
  // When opened from a clicked feed prompt: lock the body for paid prompts and
  // carry the creator's exposed variables (which may be checkbox/image types
  // that can't be inferred from the visible template via regex).
  const [locked, setLocked] = useState(false);
  type SeedVariable = { id: string; name: string; label: string; type: string; defaultValue: string; values: string[] };
  const [seededVariables, setSeededVariables] = useState<SeedVariable[] | null>(null);

  // Seed the modal from a clicked feed prompt.
  useEffect(() => {
    if (!seedPrompt) return;
    const isPaid = seedPrompt.visibility === "vars-only";
    const body = seedPrompt.promptTemplate || "";
    const seededValues: Record<string, string> = {};
    const mapped: SeedVariable[] = (seedPrompt.variables || []).map((v) => {
      const token = `[${v.name}]`;
      const val = typeof v.value === "boolean" ? "" : String(v.value ?? "");
      seededValues[token] = val;
      return {
        id: token,
        name: v.name,
        label: v.label || v.name,
        type: v.type === "checkbox" || v.type === "image" ? v.type : "text",
        defaultValue: val,
        values: [val],
      };
    });
    setPrompt(body);
    setValueByToken(seededValues);
    setSeededVariables(mapped.length ? mapped : null);
    setLocked(isPaid);
    setReferenceImages([]);
    setNftImages([]);
    setResults([]);
    setOpen(true);
  }, [seedPrompt]);

  const closeModal = () => {
    setOpen(false);
    setResults([]);
    setLocked(false);
    setSeededVariables(null);
    setPrompt("");
    setValueByToken({});
    onSeedClose?.();
  };

  // Detect [bracket] variables; preserve entered values keyed by token.
  const variables = useMemo(() => {
    const seen = new Set<string>();
    const out: {
      id: string;
      name: string;
      label: string;
      type: string;
      defaultValue: string;
      values: string[];
    }[] = [];
    const re = /\[([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prompt)) !== null) {
      const full = m[0];
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({
        id: full,
        name: m[1],
        label: m[1],
        type: "text",
        defaultValue: "",
        values: [valueByToken[full] ?? ""],
      });
    }
    return out;
  }, [prompt, valueByToken]);

  const generate = async (count: number) => {
    if (generating) return;
    if (refsLoading) {
      toast({ title: "Images still loading", description: REFS_LOADING });
      return;
    }
    const final = prompt.replace(/\[[^\]]+\]/g, (tok) => valueByToken[tok] || tok);
    if (!final.trim()) {
      toast({ title: "Error", description: "Please enter a prompt.", variant: "destructive" });
      return;
    }
    const tier = resolution === "1K" || resolution === "2K" || resolution === "4K" ? resolution : null;
    if (!core.entry || !tier) {
      toast({ title: "Pick a model", description: "Choose the model to generate with. Nothing was generated.", variant: "destructive" });
      return;
    }
    setGenerating(true);
    try {
      const refs = [...referenceImages, ...nftImages].filter(Boolean);
      // A clicked feed prompt travels as itself: its artist share is priced
      // and, for a paid prompt, the server fills the artist's own text.
      const variableValues = Object.fromEntries(
        Object.entries(valueByToken).map(([tok, v]) => [tok.replace(/^\[|\]$/g, ""), v]),
      );
      // The count the sheet shows and prices is the count generated, one
      // payment each.
      for (let n = 0; n < count; n++) {
        const outcome = await runGeneration(
          {
            model: core.entry,
            resolution: tier,
            boost: core.boostAvailable && boost,
            prompt: final.trim(),
            promptId: seedPrompt?.id || undefined,
            variableValues: seedPrompt ? variableValues : undefined,
            aspectRatio: ratio,
            referenceImages: refs.length ? refs : undefined,
          },
          signPayment,
        );
        if (!outcome.ok) throw new Error(outcome.error);
        const data = { imageUrl: outcome.imageUrl };

        // Surface the new image ABOVE the modal (newest first); keep the modal open.
        setResults((prev) => [data.imageUrl as string, ...prev]);
        if (userKey) {
          addCreation(userKey, {
            id: `gl-${Date.now()}`,
            imageUrl: data.imageUrl,
            prompt: final,
            createdAt: new Date().toISOString(),
          });
          window.dispatchEvent(new Event("gallery-refresh"));
        }
      }
      toast({ title: "Generated & saved to gallery", description: `Your ${core.entry.name} image${count > 1 ? "s are" : " is"} ready.` });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Generation failed", description: msg, variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  // Pick an NFT as a reference. The real wallet NFT-picker isn't built in this
  // free build yet — for now this opens a file picker so the NFT deck is
  // usable; swap this for the wallet's NFT selection flow when ready.
  /* The NFT button opens the WALLET picker — it used to click the hidden
     file input, so "NFTs" opened an upload-from-PC dialog (Kev, 2026-08-22).
     The file input stays for the plain image-upload path only. */
  const pickNFT = () => setNftPickerOpen(true);

  const addToList = (
    files: FileList,
    setList: Dispatch<SetStateAction<string[]>>
  ) => {
    Array.from(files).forEach((file) => {
      // Per-model allowed filetypes + max reference images (models table).
      if (modelLimits.filetypes.length && file.type && !modelLimits.filetypes.includes(file.type)) {
        toast({ title: "File type not supported", description: `${file.name} — this model accepts ${modelLimits.filetypes.map((t) => t.split("/")[1]).join(", ")}.`, variant: "destructive" });
        return;
      }
      void readRef(file).then((url) => {
        if (url) {
          setList((prev) => {
            if (prev.length >= modelLimits.maxRefs) {
              toast({ title: "Reference limit reached", description: `This model allows up to ${modelLimits.maxRefs} reference images.` });
              return prev;
            }
            return [...prev, url];
          });
        }
      });
    });
  };

  const addReferenceImages = (files: FileList) => addToList(files, setReferenceImages);

  const reorder = (list: string[], from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
      return list;
    }
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  };

  return (
    <>
      {/* The wallet NFT picker — capped by the model's own reference limit. */}
      {nftPickerOpen && (
        <NftPickerModal
          max={Math.max(0, (core.entry?.maxRefs ?? 14) - referenceImages.length - nftImages.length)}
          onPick={(urls) => setNftImages((prev) => [...prev, ...urls])}
          onClose={() => setNftPickerOpen(false)}
        />
      )}
      {/* Ratings & comments for the opened prompt — floats above the modal. */}
      {open && seedPrompt && <PromptEngagement promptId={String(seedPrompt.id)} />}

      <EnkiMobileGenerateModal
        isOpen={open}
        onClose={closeModal}
        promptBody={prompt}
        // Paid (vars-only) prompts keep the body hidden/locked: no setter → read-only.
        setPromptBody={locked ? undefined : setPrompt}
        // Prefer the creator's exposed variables when a prompt was clicked;
        // otherwise infer text variables from the typed body.
        variables={seededVariables ?? variables}
        onVariableChange={(id, val) => setValueByToken((prev) => ({ ...prev, [id]: val }))}
        onAddVariable={() => {
          const n = variables.length + 1;
          setPrompt((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}[var_${n}]`);
        }}
        onRemoveVariable={(name) => setPrompt((prev) => prev.split(`[${name}]`).join("").replace(/\s{2,}/g, " ").trim())}
        models={{ available: core.catalogue.map((m) => ({ id: m.id, name: m.name, price: m.price })), selected: core.entry ? [core.entry.id] : [] }}
        setModel={setModel}
        ratios={{ available: core.ratios, selected: ratio }}
        setRatio={setRatio}
        priceFor={priceFor}
        resolution={resolution}
        setResolution={setResolution}
        resolutionOptions={core.tiers.map((t, i) => ({ value: t.tier, label: tierLabel(i) ? `${t.tier} · ${tierLabel(i)}` : t.tier, short: t.tier }))}
        referenceImages={referenceImages}
        onAddReferenceImages={addReferenceImages}
        onRemoveReferenceImage={(i) =>
          setReferenceImages((prev) => prev.filter((_, idx) => idx !== i))
        }
        onReorderReferenceImages={(from, to) =>
          setReferenceImages((prev) => reorder(prev, from, to))
        }
        onPickNFT={pickNFT}
        nftImages={nftImages}
        onRemoveNFT={(i) => setNftImages((prev) => prev.filter((_, idx) => idx !== i))}
        onReorderNFTs={(from, to) => setNftImages((prev) => reorder(prev, from, to))}
        generateLabel={generating ? "Generating…" : refsLoading ? "Loading images…" : "Generate"}
        generateBlocked={refsLoading}
        boost={boost}
        onBoostChange={core.boostAvailable ? setBoost : undefined}
        hideReleaseTab
        resultImages={results}
        isGenerating={generating}
        onGenerate={generate}
        onOpenPromptEditor={() => router.push("/editor")}
      />

      {/* "stern Generate" floating button — matches the /editor launcher */}
      {!open && (
        <div
          className="ek-generate-launcher"
          style={{
            position: "fixed",
            bottom: 24,
            left: 16,
            right: 16,
            zIndex: 150,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <button
            type="button"
            onClick={() => setOpen(true)}
            style={{
              width: "100%",
              maxWidth: 560,
              background: "var(--qc-bg)",
              color: "var(--qc-ink)",
              padding: "16px 24px",
              borderRadius: 32,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              border: "none",
              boxShadow: "0 12px 32px rgba(0,0,0,0.2)",
              cursor: "pointer",
              pointerEvents: "auto",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Sparkles size={18} style={{ fill: "var(--qc-ink)" }} />
              <span style={{ fontFamily: "var(--font-outfit), 'Outfit', sans-serif", fontSize: 16, fontWeight: 500 }}>
                Generate
              </span>
            </div>
            <span style={{ fontFamily: "var(--font-instrument-serif), 'Playfair Display', serif", fontStyle: "italic", fontSize: 15, color: "var(--qc-ink)", opacity: 0.7 }}>
              new image
            </span>
          </button>
        </div>
      )}
    </>
  );
}
