"use client";

/**
 * The Prompt Editor (plan §2.1; it replaces Create Prompt 1 and 2): write a
 * prompt with [variables] and references, render tests, star the set that
 * shows it best, release it. One tree for every width; prompt-editor.css
 * switches between two columns and the Craft | Verify tabs.
 *
 * Wired only to the backend that exists (plan §5). A test render is the
 * creator's own draft: runGeneration with `authoring`, never a promptId. Every
 * price is a server quote. The draft lives in this browser. The one server
 * write is Release, POST /api/prompt with `release: true`; after the first one
 * the editor stays, on /editor?id=, and the next release updates (R13).
 */
import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useBetaAccess } from "@/components/BetaGate";
import { WalletPickerModal } from "@/components/WalletPickerModal";
import NftPickerModal from "@/components/enki/NftPickerModal";
import AddFundsPopover from "@/components/kit/AddFundsPopover";
import { notify } from "@/components/kit/notify";
import { useGrowOnly } from "@/components/kit/useGrowOnly";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDiceRoll } from "@/hooks/useDiceRoll";
import { useGenerationCore } from "@/hooks/useGenerationCore";
import { useHoldings } from "@/hooks/useHoldings";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useModelLimits, type CatalogueEntry } from "@/hooks/useModelLimits";
import { useReferenceReads, type NftPick } from "@/hooks/useReferenceReads";
import { useRenderQueue } from "@/hooks/useRenderQueue";
import { quoteLabel, useServerQuotes } from "@/hooks/useServerQuotes";
import { useViewerWallets } from "@/hooks/useViewerWallets";
import {
  editorRequest, editorSetup, generateBlock, readyRefs, renderSettings,
  type EditorSetup, type GenerateBlock, type RenderPicks,
} from "@/lib/editor/generate-checks";
import { insertToken, parseTokens, removeRef, varNames } from "@/lib/editor/prompt-tokens";
import { MAX_QUOTES, quoteBatch, quoteIn, quoteRequest } from "@/lib/editor/quote-batch";
import { listingOnly, releaseBlock, releaseBody, storedRefs, updateBody, type Listing, type ReleaseBody } from "@/lib/editor/release";
import { suggestedName, type VariableRange } from "@/lib/editor/selection-variable";
import { needFor, starred, starsForFree, toggleStar, variationKey, variations, type Variation } from "@/lib/editor/variations";
import { openLogin } from "@/lib/openLogin";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { COARSE, TABS } from "@/lib/ui/kit/breakpoints";
import { openAddFunds } from "@/lib/ui/kit/controls";
import { balanceView, chipLabel } from "@/lib/ui/kit/price";
import { parseRatio } from "@/lib/ui/kit/ratio";
import { quotaText } from "@/lib/ui/kit/render-queue";
import { refToken } from "@/lib/ui/kit/tile";
import EditorHeader, { type EditorTab, type PaneProps } from "./EditorHeader";
import GenerateBar from "./GenerateBar";
import GeneratorRow from "./GeneratorRow";
import ListingRow, { MODE_TITLE } from "./ListingRow";
import LiveShowcase from "./LiveShowcase";
import LiveStrip from "./LiveStrip";
import PromptField from "./PromptField";
import ReferenceStrip from "./ReferenceStrip";
import ReleaseBar from "./ReleaseBar";
import RenderPreview from "./RenderPreview";
import type { EditorJob, TileActs } from "./ResultTile";
import SplitDivider, { useSplit } from "./SplitDivider";
import VariableList from "./VariableList";
import VerifyPane from "./VerifyPane";
import { blankVariable, usePromptEditor, variableFrom } from "./usePromptEditor";
import { promptKey, usePromptLoad } from "./usePromptLoad";
import "./prompt-editor.css";
import "./verify.css";

/** The most references a prompt is saved with (app/api/prompt). */
const SAVE_REFS = 14;
const QUALITY: Record<string, string> = { low: "Low", medium: "Mid", high: "High" };

/** What Generate runs: the editor as it is, or a job again (Regenerate; Retry takes a failed one's place). */
type Source = { job?: EditorJob; retry?: boolean };
type Ask = { text: string; ok: string; cancel: string; run: () => void };

export const leaveText = (n: number) =>
  `${n} image${n === 1 ? " is" : "s are"} still rendering. They're still charged and saved to your gallery, but won't appear here. Leave?`;

const onResize = (on: () => void) => {
  window.addEventListener("resize", on);
  return () => window.removeEventListener("resize", on);
};
const sameListing = (a: Listing, b: Listing) =>
  a.title === b.title && a.mode === b.mode && a.price === b.price && a.category === b.category && a.primaryId === b.primaryId;
const fieldOf = (name: string, field: "name" | "value") => `[data-pe-name="${CSS.escape(name)}"] [data-pe-field="${field}"]`;

export default function PromptEditor({ promptId, onReleased }: {
  /** A released prompt of this account to edit (?id=). */
  promptId?: string;
  /** The first release made this prompt: the route keeps this editor as it moves to ?id=. */
  onReleased?: (id: string) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { access, role, userId } = useBetaAccess();
  // Team-cookie browsing is looking around, not an account (EnkiHome).
  const signedIn = access === "ok" && role !== "team";
  const { userKey, payer } = useViewerWallets();
  const [releasedId, setReleasedId] = useState<string | null>(null);
  const id = releasedId ?? promptId ?? null;
  const { state, doc, dispatch, commit, store, decideSeed } = usePromptEditor(userKey, id, signedIn ? userId : null);
  const { listing, picks, history } = state;

  const core = useGenerationCore(listing.testId ?? listing.primaryId ?? undefined);
  const { catalogue } = core;
  const models = useMemo(() => catalogue.filter((m) => m.mediaType === "image"), [catalogue]);
  const test = core.entry;
  const primary = catalogue.find((m) => m.id === listing.primaryId);
  const { accept } = useModelLimits(test?.id);
  const cap = Math.min(SAVE_REFS, test?.maxRefs ?? SAVE_REFS);

  const editing = promptId !== undefined && promptId !== releasedId;
  const load = usePromptLoad(editing ? promptId : null, catalogue);
  const { loaded } = load;
  if (loaded && state.seeded !== loaded.id) dispatch({ type: "seed", loaded });

  const reads = useReferenceReads();
  const queue = useRenderQueue<EditorSetup>({
    toRequest: (s) => editorRequest(s, catalogue, readyRefs(state.refs, s.refIds) ?? []),
    persist: store.jobs,
    freeModelSelected: signedIn && test?.free === true,
    quotaKey: signedIn ? userId : null,
  });
  const { jobs } = queue;
  const groups = useMemo(() => variations(jobs, state.order), [jobs, state.order]);
  const rendering = jobs.filter((j) => j.status === "rendering").length;

  const tabs = useMediaQuery(TABS);
  const vh = useSyncExternalStore(onResize, () => window.innerHeight, () => 800);
  const { isHeld, hold, release } = useGrowOnly();
  const { measure, split } = useSplit();

  const [tab, setTab] = useState<EditorTab>("craft");
  // Below 1024 px the panes are the tabs' panels (EditorHeader).
  const uid = useId();
  const panes: Record<EditorTab, string> = { craft: `${uid}craft`, verify: `${uid}verify` };
  const pane = (t: EditorTab): PaneProps => ({ id: panes[t], role: tabs ? "tabpanel" : undefined, "aria-labelledby": tabs ? `${panes[t]}-tab` : undefined });
  const [viewer, setViewer] = useState<string | null>(null);
  const [funds, setFunds] = useState<Source | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [nftOpen, setNftOpen] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [refDrag, setRefDrag] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [openStacks, setOpenStacks] = useState<ReadonlySet<string>>(() => new Set());
  // Names the "+ Variable" pill made up, shown red until the row is edited or left.
  const [suggested, setSuggested] = useState<ReadonlySet<string>>(() => new Set());

  const root = useRef<HTMLDivElement>(null);
  const caretKnown = useRef(false);
  // A release that answers after the editor was left must not bring it back.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Runs once after the next render: focus a field that is only there now.
  const after = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const run = after.current;
    after.current = null;
    run?.();
  });

  // ── Prices: one server batch for every figure shown (lib/editor/quote-batch).
  const entryOf = (j: EditorJob) => catalogue.find((m) => m.id === j.setup.modelId);
  const viewerJob = viewer ? jobs.find((j) => j.id === viewer) : undefined;
  const again = viewerJob ?? funds?.job;
  const againAsk = again ? quoteRequest(entryOf(again), again.setup, again.setup.refIds.length) : null;
  const refCount = doc.refIds.length;
  const base = quoteBatch(catalogue, test, picks, refCount);
  // The job a viewer may run again is asked too, ahead of the menus (at most MAX_QUOTES).
  const batch = !againAsk || base.some((q) => JSON.stringify(q) === JSON.stringify(againAsk))
    ? base : [againAsk, ...base].slice(0, MAX_QUOTES);
  const quotes = useServerQuotes(signedIn ? batch : []);
  const price = (entry: CatalogueEntry | undefined, at: RenderPicks, n: number) => quoteIn(batch, quotes, quoteRequest(entry, at, n));
  const chipQuote = price(test, picks, refCount);
  const { balance, ready } = useHoldings(payer);
  const balanceUsd = payer && ready ? balance : null;

  // ── Moving focus, and the tab it sits in.
  const toCraft = (then: () => void) => {
    if (tab === "craft") return then();
    setTab("craft");
    after.current = then;
  };
  const focus = (selector: string) => toCraft(() => root.current?.querySelector<HTMLElement>(selector)?.focus());
  const openMenu = (selector: string) => toCraft(() => root.current?.querySelector<HTMLButtonElement>(`${selector} .kit-pill`)?.click());

  // ── Generate.
  const act = (b: GenerateBlock, from: Source) => {
    if (b.toast) notify(b.toast);
    if (b.focus) focus(fieldOf(b.focus.variable, b.check === "values" ? "value" : "name"));
    if (b.open === "login") openLogin();
    if (b.open === "primary") openMenu(".pe-primary");
    if (b.open === "wallet") setWalletOpen(true);
    if (b.open === "add-funds") setFunds(from);
  };
  /**
   * Generate, Regenerate and Retry: every check first, and a job only
   * when every one passes (R12). The check that stopped it, or null once the
   * job runs.
   */
  const attempt = (from: Source, lowBalanceOk = false): GenerateBlock | null => {
    const { job } = from;
    if (job && from.retry && job.error?.payment) {
      if (!signedIn) { openLogin(); return { check: "login", open: "login" }; }
      if (!job.error.payment.generationSubmitted && readyRefs(state.refs, job.setup.refIds) === null) {
        const toast = "Wait for the reference images before continuing this payment.";
        notify(toast);
        return { check: "refs-ready", toast };
      }
      queue.retry(job.id);
      return null;
    }
    const entry = job ? entryOf(job) : test;
    if (entry?.free && (!queue.freeQuota || queue.freeQuota.exhausted)) {
      const toast = queue.freeQuota?.exhausted ? "Your daily free image has been used. Choose a paid generator to keep going." : "The free allowance could not be checked yet. Please try again.";
      notify(toast);
      return { check: "generator", toast };
    }
    const content = job ? job.setup : doc;
    const at = job ? job.setup : picks;
    const block = generateBlock({
      doc: content,
      refs: state.refs,
      reading: !job && reads.loading,
      signedIn,
      entry,
      picks: at,
      quote: price(entry, at, content.refIds.length),
      wallet: !!payer,
      balanceUsd,
      lowBalanceOk,
    });
    if (block || !entry) {
      if (block) act(block, from);
      return block ?? { check: "generator" };
    }
    const setup = job ? job.setup : editorSetup(doc, entry, picks);
    const variation = variationKey(setup);
    dispatch({ type: "generated", variation });
    if (job && from.retry) queue.retry(job.id);
    else queue.runBatch([setup]);
    // Two columns: Verify shows where it landed. A tab stays on Craft.
    if (!tabs) after.current = () => root.current?.querySelector(`[data-pe-group="${CSS.escape(variation)}"]`)?.scrollIntoView({ block: "nearest" });
    return null;
  };
  const block = generateBlock({
    doc, refs: state.refs, reading: reads.loading, signedIn, entry: test, picks, quote: chipQuote,
    wallet: !!payer, balanceUsd, lowBalanceOk: true,
  });

  // ── The doc.
  const createVariable = (range: VariableRange) => {
    const name = suggestedName(range.name, varNames(doc.prompt));
    setSuggested((s) => new Set(s).add(name));
    // The suggestion is selected in its field, so typing replaces it.
    after.current = () => {
      const field = root.current?.querySelector<HTMLInputElement>(fieldOf(name, "name"));
      field?.focus();
      field?.select();
    };
    commit(variableFrom(range, name));
  };
  const named = (name: string) => setSuggested((s) => (s.has(name) ? new Set([...s].filter((n) => n !== name)) : s));
  const addVariable = () => {
    if (varNames(doc.prompt).includes("")) return focus(fieldOf("", "name"));
    after.current = () => root.current?.querySelector<HTMLElement>(fieldOf("", "name"))?.focus();
    commit(blankVariable);
  };
  const addRef = (src: Blob | NftPick) => {
    void reads.read(src).then((data) => {
      if (!data) return notify("That image couldn't be read", { tone: "error" });
      const refId = crypto.randomUUID();
      dispatch({ type: "ref", id: refId, ref: { data, stored: null, state: "ready" } });
      // Uploading writes its token into the prompt (handoff §4.6).
      commit((d) => ({ refIds: [...d.refIds, refId], prompt: insertToken(d.prompt, d.prompt.length, refToken(d.refIds.length)).text }));
    });
  };
  const tileClick = (refId: string) => {
    const n = doc.refIds.indexOf(refId) + 1;
    const ta = root.current?.querySelector<HTMLTextAreaElement>('[data-pe-field="prompt"]');
    const token = parseTokens(doc.prompt).find((t) => t.kind === "ref" && t.n === n);
    if (token) {
      ta?.focus();
      ta?.setSelectionRange(token.start, token.end);
      return;
    }
    const next = insertToken(doc.prompt, caretKnown.current && ta ? ta.selectionEnd : doc.prompt.length, refToken(n - 1));
    after.current = () => ta?.setSelectionRange(next.caret, next.caret);
    commit({ prompt: next.text });
  };
  const loadValues = (job: EditorJob) => {
    const s = job.setup;
    hold(["prompt", ...Object.keys(s.vars).map((n) => `var:${n}`)]);
    commit((d) => ({ prompt: s.prompt, vars: { ...d.vars, ...s.vars }, kinds: { ...d.kinds, ...s.kinds }, refIds: s.refIds, aiNames: [] }));
    setViewer(null);
    setTab("craft");
    notify("Values loaded into the editor");
  };
  const loadGroup = (g: Variation) => {
    const s = g.jobs[0].setup;
    hold(["prompt"]);
    commit((d) => ({ prompt: s.prompt, kinds: { ...d.kinds, ...s.kinds }, refIds: s.refIds }));
    setTab("craft");
    notify("Prompt loaded into the editor");
  };

  // ── Vary: the AI writes the named text values and never renders (handoff §4.7).
  const dice = useDiceRoll({
    variables: varNames(doc.prompt).filter((n) => n && (doc.kinds[n] ?? "text") === "text"),
    context: doc.prompt,
  });
  const vary = async () => {
    if (!signedIn) return openLogin();
    const values = await dice.roll();
    if (!values) return;
    commit((d) => {
      const names = new Set(varNames(d.prompt));
      const got = Object.entries(values).filter(([n]) => names.has(n));
      return { vars: { ...d.vars, ...Object.fromEntries(got) }, aiNames: got.map(([n]) => n) };
    });
    notify("New values written by the AI — check them, then Generate");
  };

  // ── Listing and stars.
  const setListing = (patch: Partial<Listing>) => dispatch({ type: "set", patch: { listing: { ...listing, ...patch } } });
  const switchMode = (mode: Listing["mode"]) => {
    if (mode === listing.mode) return;
    const go = () => {
      const kept = mode === "free" ? starsForFree(state.stars, jobs) : { stars: state.stars };
      dispatch({ type: "set", patch: { listing: { ...listing, mode }, stars: kept.stars } });
      if (kept.toast) notify(kept.toast);
      else if (window.matchMedia(COARSE).matches) notify(MODE_TITLE[mode]);
    };
    if (mode === "free" && state.seeded) setAsk({ text: "Free makes your prompt text public. Continue?", ok: "Make it Free", cancel: "Keep Premium", run: go });
    else go();
  };
  const star = (jobId: string) => {
    const r = toggleStar(state.stars, jobs, jobId, needFor(listing.mode), Date.now());
    if (r.stars !== state.stars) dispatch({ type: "set", patch: { stars: r.stars } });
    if (r.toast) notify(r.toast);
  };
  const show = (jobId: string) => {
    setViewer(jobId);
    queue.markSeen(jobId);
  };
  const rerun = (job: EditorJob, retry: boolean) => {
    const stopped = attempt({ job, retry });
    // It closes once the job runs, and for a wallet, add-funds or login prompt, which must not sit under it.
    if (!stopped || stopped.open) setViewer(null);
    if (!stopped && !retry) notify("Rendering again with the same values");
  };
  const acts: TileActs = { stars: state.stars, open: (j) => show(j.id), load: loadValues, star };

  // ── Release.
  const starredJobs = starred(state.stars, jobs);
  const updating = !!loaded && state.seeded === loaded.id && listingOnly(doc, listing, loaded, starredJobs.length);
  const verdict = releaseBlock({ listing, primary, starred: starredJobs, loaded: updating ? loaded.doc : null, busy: releasing });
  const send = async ({ body, refIds }: { body: ReleaseBody; refIds: string[] }) => {
    setReleasing(true);
    try {
      const res = await fetch("/api/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; adult?: boolean; error?: string; referenceImages?: unknown };
      if (!res.ok || !data.id) {
        if (res.status === 401) openLogin();
        const why = data.error ?? "Release failed — nothing was published";
        notify(res.status === 409 ? `${why} · release again` : why, { tone: "error" });
        return;
      }
      dispatch({ type: "released", stored: storedRefs(refIds, data.referenceImages) });
      notify(`${body.title} is live${body.price ? ` · $${body.price.toFixed(2)} per render` : ""}${data.adult ? " · marked 18+, shown only to viewers who may see 18+" : ""}`);
      void queryClient.invalidateQueries({ queryKey: ["/api/prompts"] });
      // Home and creator shelves must read the new listing even while their cache is fresh.
      void queryClient.invalidateQueries({ queryKey: ["/api/marketplace/prompts"] });
      void queryClient.invalidateQueries({ queryKey: promptKey(data.id) });
      // The Image View's copy of it, which the owner may render from next.
      void queryClient.invalidateQueries({ queryKey: [`/api/prompts/${data.id}`] });
      void queryClient.invalidateQueries({ queryKey: ["prompt-public-images", data.id] });
      if (!body.id) {
        // The draft moves to its id: the "new" one goes, and the editor stays (R13), unless it was left meanwhile.
        store.clear();
        if (!mounted.current) return;
        setReleasedId(data.id);
        onReleased?.(data.id);
        router.replace(`/editor?id=${data.id}`);
      }
    } catch {
      notify("Release failed — check your connection and try again", { tone: "error" });
    } finally {
      setReleasing(false);
    }
  };
  const releaseNow = () => {
    if (!signedIn) return openLogin();
    if (verdict) {
      if (verdict.message) notify(verdict.message);
      if (verdict.focus === "title") root.current?.querySelector<HTMLElement>('[data-pe-field="title"]')?.focus();
      else if (verdict.focus === "price") focus('[data-pe-field="price"]');
      else if (verdict.focus) focus(fieldOf(verdict.focus.variable, verdict.check === "values" ? "value" : "name"));
      if (verdict.open) openMenu(verdict.open === "primary" ? ".pe-primary" : ".pe-category");
      return;
    }
    if (!primary) return;
    const made = updating && loaded
      ? { body: updateBody({ listing, primary, saved: loaded.saved, id: loaded.id }), refIds: loaded.doc.refIds }
      : releaseBody({ listing, primary, starred: starredJobs, refs: state.refs, id: id ?? undefined });
    if ("error" in made) return notify(made.error, { tone: "error" });
    void send(made);
  };

  // ── Leaving while renders run: they are still charged, and they land in the gallery, not here.
  const leave = () => {
    if (!rendering) return router.push("/home");
    setAsk({ text: leaveText(rendering), ok: "Leave", cancel: "Stay", run: () => router.push("/home") });
  };
  const busy = rendering > 0;
  useEffect(() => {
    if (!busy) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [busy]);

  // ⌘Z / ⇧⌘Z / Ctrl+Y undo the doc; the title and the price keep their own field undo.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || viewer) return;
    if (e.target instanceof Element && e.target.closest("[data-native-undo]")) return;
    const k = e.key.toLowerCase();
    const forward = k === "y" || (k === "z" && e.shiftKey);
    if (k !== "z" && !forward) return;
    e.preventDefault();
    dispatch({ type: forward ? "redo" : "undo" });
  });
  useEffect(() => {
    const on = (e: KeyboardEvent) => onKey(e);
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);

  // ── What the screen says.
  const anyReady = jobs.some((j) => j.status === "ready");
  const settings = test ? renderSettings(test, picks) : null;
  const costLeft = block?.toast
    ?? (!signedIn ? "Sign in to generate"
      : !test || !settings ? "Pick a generator"
      : test.free ? (queue.freeQuota?.exhausted ? "Your daily free image is used. Pick a paid generator to continue." : queue.note ? quotaText(queue.note) : queue.freeQuota ? `${test.name} · ${queue.freeQuota.remaining} daily free image available` : "Checking your daily free image allowance…")
      : `${test.name} · ${settings.resolution}${settings.quality ? ` · ${QUALITY[settings.quality]}` : ""}${settings.boost ? " · Boost" : ""} · payment reserved, unused payments refunded`);
  const bal = balanceView({ payer, ready, balance, free: !test || test.free, quote: chipQuote });
  const pending = signedIn && !!test && !test.free && !chipQuote;
  const fundsQuote = funds ? (funds.job ? price(entryOf(funds.job), funds.job.setup, funds.job.setup.refIds.length) : chipQuote) : null;
  const againEntry = viewerJob && entryOf(viewerJob);
  const againPrice = againEntry?.free ? "$0.00" : quoteLabel(viewerJob && price(againEntry, viewerJob.setup, viewerJob.setup.refIds.length)) ?? "…";
  const restoredOver = state.restored && !!loaded && state.seeded === loaded.id
    && !(listingOnly(doc, listing, loaded, 0) && sameListing(listing, loaded.listing));
  const [min, max] = tabs ? [200, 420] : [400, Math.round(vh * 0.72)];

  return (
    <div ref={root} className="pe-root kit-focus" data-tab={tab}>
      <EditorHeader title={listing.title} onTitle={(title) => setListing({ title })}
        done={[!!doc.prompt.trim(), anyReady, state.released]}
        active={state.released || anyReady ? 2 : jobs.length ? 1 : 0}
        tab={tab} onTab={setTab} tabs={tabs} panes={panes} rendering={rendering} onBack={leave}
        notice={restoredOver && loaded && (
          <p className="pe-notice">
            Restored your unsaved changes ·{" "}
            <button type="button" onClick={() => dispatch({ type: "seed", loaded, discard: true })}>Discard</button>
          </p>
        )} />
      <div ref={measure} className="pe-body" style={{ "--pe-split": `${split.value}px` } as CSSProperties}>
        {editing && load.missing ? (
          <div className="pe-state">
            <p>This prompt can&apos;t be opened here (not found, or not yours).</p>
            <button type="button" className="pe-add kit-hit" onClick={leave}>Back</button>
          </div>
        ) : editing && load.failed ? (
          <div className="pe-state">
            <p>Couldn&apos;t load this prompt.</p>
            <button type="button" className="pe-add kit-hit" onClick={load.retry}>Try again</button>
          </div>
        ) : editing && load.loading ? (
          <div className="pe-state" aria-busy="true" aria-label="Loading the prompt">
            <span className="pe-skel" /><span className="pe-skel" /><span className="pe-skel pe-skel--tall" />
          </div>
        ) : (
          <>
            <div className="pe-craft" {...pane("craft")}>
              <ListingRow listing={listing} onMode={switchMode} onPrice={(p) => setListing({ price: p })}
                onCategory={(category) => setListing({ category })} />
              <GeneratorRow models={models} value={listing.primaryId} prices={models.map((m) => price(m, picks, refCount))}
                onPick={(primaryId) => setListing({ primaryId })} />
              <PromptField value={doc.prompt} refCount={refCount} min={min} max={max} growOnly={isHeld("prompt")}
                onUserInput={() => release("prompt")} onEdit={(prompt, key) => commit({ prompt }, key)}
                onCreateVariable={createVariable} onAddVariable={addVariable}
                onFocus={() => { caretKnown.current = true; }}
                history={{
                  canUndo: history.past.length > 0,
                  canRedo: history.future.length > 0,
                  undo: () => dispatch({ type: "undo" }),
                  redo: () => dispatch({ type: "redo" }),
                }}
                refDrag={refDrag} />
              <VariableList doc={doc} commit={commit} isHeld={isHeld} release={release} onAdd={addVariable}
                suggested={suggested} onNamed={named} />
              <ReferenceStrip doc={doc} refs={state.refs} pending={reads.pending} cap={cap} accept={accept}
                nft={tabs ? "tile" : "link"} onAddFiles={(files) => files.forEach(addRef)}
                onRemove={(refId) => commit((d) => ({ prompt: removeRef(d.prompt, d.refIds.indexOf(refId) + 1), refIds: d.refIds.filter((r) => r !== refId) }))}
                onTile={tileClick} onNft={() => setNftOpen(true)} onDragToken={setRefDrag} />
              <GenerateBar
                live={<LiveStrip jobs={jobs} stars={state.stars} onOpen={(j) => show(j.id)} onAll={() => setTab("verify")} />}
                models={models} testId={test?.id ?? null} primaryId={listing.primaryId}
                onTest={(testId) => setListing({ testId: testId === listing.primaryId ? null : testId })}
                core={core} picks={picks} onPicks={(patch) => dispatch({ type: "set", patch: { picks: { ...picks, ...patch } } })}
                prices={{
                  models: models.map((m) => price(m, picks, refCount)),
                  tiers: core.tiers.map((t) => price(test, { ...picks, resolution: t.tier }, refCount)),
                  qualities: (["low", "medium", "high"] as const).map((quality) => price(test, { ...picks, quality }, refCount)),
                }}
                vary={{ onVary: () => void vary(), rolling: dice.rolling, unavailable: dice.unavailable }}
                generate={{
                  label: "✦ Generate",
                  chip: chipLabel({ signedIn, free: !!test?.free, quote: chipQuote, pending }),
                  chipPending: pending,
                  dimmed: !!block?.toast,
                  onPress: () => attempt({}),
                  size: tabs ? "block" : "bar",
                }}
                cost={{ left: costLeft, balance: bal && { ...bal, onAddFunds: openAddFunds } }}>
                {funds && fundsQuote && (
                  <AddFundsPopover balanceUsd={balanceUsd ?? 0} totalUsd={fundsQuote.totalUsd} onAddFunds={openAddFunds}
                    onTryAnyway={() => attempt(funds, true)} onClose={() => setFunds(null)} />
                )}
              </GenerateBar>
            </div>
            <SplitDivider split={split} />
            <VerifyPane pane={pane("verify")} groups={groups} need={needFor(listing.mode)} wide={(parseRatio(picks.ratio) ?? 1) > 1}
              open={openStacks} acts={acts} onLoad={loadGroup} onCraft={() => setTab("craft")}
              onToggle={(key) => setOpenStacks((o) => {
                const next = new Set(o);
                if (!next.delete(key)) next.add(key);
                return next;
              })}
              showcase={loaded && state.seeded === loaded.id && <LiveShowcase photos={loaded.saved.uploadedPhotos} />}
              release={
                <ReleaseBar need={needFor(listing.mode)} ratio={picks.ratio} listingOnly={updating}
                  photos={updating && loaded
                    ? loaded.saved.uploadedPhotos.map((src) => ({ key: src, src, ratio: null }))
                    : starredJobs.map((j) => ({ key: j.id, src: j.imageUrl ?? "", ratio: j.setup.ratio }))}
                  released={state.released} blocked={!!verdict && verdict.check !== "busy"} busy={releasing} anyReady={anyReady}
                  mode={listing.mode} price={listing.price} onRelease={releaseNow} onMore={() => setTab("craft")} />
              } />
          </>
        )}
      </div>
      {viewerJob && viewerJob.status !== "rendering" && (
        <RenderPreview job={viewerJob} groups={groups} stars={state.stars} price={againPrice} stacked={tabs}
          onShow={show} onClose={() => setViewer(null)} onUse={loadValues} onStar={star} onRun={rerun}
          onRemove={(jobId) => {
            queue.drop(jobId);
            setViewer(null);
          }} />
      )}
      <WalletPickerModal open={walletOpen} onClose={() => setWalletOpen(false)} />
      {nftOpen && (
        <NftPickerModal max={Math.max(0, cap - refCount - reads.pending.length)} onClose={() => setNftOpen(false)}
          onPick={(nfts) => nfts.forEach(addRef)} />
      )}
      <AlertDialog open={!!state.pendingSeed} onOpenChange={(open) => { if (!open) decideSeed(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your unsaved draft?</AlertDialogTitle>
            <AlertDialogDescription>The saved prompt text will replace this draft. Your library entry stays unchanged.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my draft</AlertDialogCancel>
            <AlertDialogAction onClick={() => decideSeed(true)}>Replace draft</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!ask} onOpenChange={(open) => { if (!open) setAsk(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>{ask?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{ask?.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => ask?.run()}>{ask?.ok}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
