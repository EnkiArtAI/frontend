"use client";

/**
 * Everything the Image View shows and does, for every layout (desktop and
 * tablet here, the phone in IV1c): the prompt and what the server knows
 * about it, the composer, the render queue, and which image is on the stage.
 * A layout only arranges it and keeps its own UI state (viewer, rail, tabs).
 *
 * Every price is a server quote; where no route returns a number, none is
 * shown (plan §5). The blank composer (`seed = "blank"`, the launcher) is the
 * same model without a prompt: the buyer's own text, every image generator,
 * nothing preselected, no history and no discussion.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBetaAccess } from "@/components/BetaGate";
import { notify } from "@/components/kit/notify";
import { useGrowOnly } from "@/components/kit/useGrowOnly";
import { useBookmarkIndex } from "@/hooks/useBookmarkIndex";
import type { Membership } from "@/lib/ui/feed/bookmark-index";
import { useComposerQuote } from "@/hooks/useComposerQuote";
import { useGenerationCore, type GenerationCore } from "@/hooks/useGenerationCore";
import { useHoldings } from "@/hooks/useHoldings";
import { boostAt, useModelCatalogue, useModelLimits, type CatalogueEntry } from "@/hooks/useModelLimits";
import { REFS_LOADING, useReferenceReads, type NftPick } from "@/hooks/useReferenceReads";
import { useRenderQueue } from "@/hooks/useRenderQueue";
import { useServerQuotes } from "@/hooks/useServerQuotes";
import { useViewerWallets } from "@/hooks/useViewerWallets";
import type { GenerationQuote, QuoteRequest } from "@/lib/generation-checkout";
import { tiersUpTo, type ResolutionTier } from "@/lib/generation/resolution";
import type { VariableRange } from "@/lib/editor/selection-variable";
import { offeredModels } from "@/lib/offered-models";
import { openLogin } from "@/lib/openLogin";
import { REFS_TOO_LARGE, tooLargeToSend } from "@/lib/request-size";
import { sessionAuthHeaders, viewerHeaders } from "@/lib/session-headers";
import { clipboardText, promptRefusal } from "@/lib/ui/image-view/assemble";
import { loadDiscussion, loadLikes, type Discussion } from "@/lib/ui/image-view/discussion";
import { hasGenerated, publicShots, recordOf, type GenerationRow } from "@/lib/ui/image-view/history";
import { defaultModel, isFreePrompt, modelOptions, refCap, refSlots } from "@/lib/ui/image-view/models";
import { matchVariable, parseSegments, type PromptVariable, type Segment } from "@/lib/ui/image-view/segments";
import type { ImageViewSeed } from "@/lib/ui/image-view/seed";
import { againStep, makeSetup, quoteOf, toRequest, type ImageSetup, type JobPrice } from "@/lib/ui/image-view/setups";
import { fieldsFor, initialValues, missingRequired, type Field } from "@/lib/ui/image-view/variables";
import { openAddFunds } from "@/lib/ui/kit/controls";
import { formatAgo } from "@/lib/ui/kit/format";
import { balanceView, chipLabel } from "@/lib/ui/kit/price";
import { leaveSummary, quotaText, type Job } from "@/lib/ui/kit/render-queue";
import { useOwnRenders } from "./useOwnRenders";

/** GET /api/prompts/[id] → prompt, the fields this view reads. */
interface PromptRecord {
  title?: string;
  prompt_type?: string | null;
  is_free_showcase?: boolean | null;
  ai_model?: string | null;
  /** The prompt's other settings; `models` names the generators on offer (lib/offered-models). */
  ai_settings?: unknown;
  aspect_ratio?: string | null;
  resolution?: string | null;
  creator_id?: string | null;
  /**
   * Only a free prompt's. When its text could not be decrypted the route
   * still sends the stored 220-character excerpt, which this view cannot
   * tell from the whole text; only a prompt without either reads as missing.
   */
  publicPromptText?: string;
  showcaseImages?: { url: string }[];
  /** The images the creator released it with; the route sends them to the creator alone (uploads nothing has checked yet, Kev 2026-10-08). */
  beforeImages?: { url: string }[];
  promptData?: { variables?: PromptVariable[] };
}

export type Status = "loading" | "gone" | "failed" | "ready";

/** The prompt read's state: a 404 is a prompt this viewer may not see (unlisted, 18+, hidden creator). */
export function loadState(q: { isPending: boolean; error: Error | null }): Status {
  if (q.error) return /^404\b/.test(q.error.message) ? "gone" : "failed";
  return q.isPending ? "loading" : "ready";
}

/** One image the page can show: a render of this tab, a creator example, a public image made with the prompt, or one of the viewer's own. */
export interface Shot {
  /** "job:<id>", "example:<n>", "community:<id>" or "history:<id>". */
  key: string;
  kind: "job" | "example" | "community" | "history";
  /** What the stage and the viewer show; absent while a job renders and after it failed. */
  src?: string;
  /** The small version, for strips and the rail. */
  thumb?: string;
  /** What Download saves: the stored original. */
  original?: string;
  /** The ratio asked for, until the picture loads and says its own. */
  ratio: string | null;
  job?: Job<ImageSetup>;
  /** The viewer's own recorded render: it carries the Public switch. */
  record?: GenerationRow;
  /** Someone else's public image: it carries Report. */
  publicId?: string;
  createdAt?: string;
}

/** What an image says about itself, on the stage and in the viewer. Never a model or a size the server did not return (plan §5 #16, #17). */
export function metaOf(s: Shot, now: number): string | null {
  const j = s.job;
  if (j) {
    if (j.status !== "ready") return j.status === "rendering" ? "rendering…" : null;
    return `${j.setup.model.name} · ${j.size ? `${j.size.w}×${j.size.h}` : j.setup.resolution} · ${j.setup.aspectRatio} · yours`;
  }
  if (s.kind === "history") return `yours · ${formatAgo(s.createdAt ?? "", now)}`;
  return s.kind === "example" ? "creator example" : "made with this prompt";
}

export const copyText = (text: string, said: string) =>
  void navigator.clipboard.writeText(text).then(() => notify(said), () => notify("Couldn't copy that", { tone: "error" }));

/** The grow-only key of the prompt text itself. */
export const PROMPT_KEY = "\u0000prompt";
const GENERATE = "✦ Generate";
type Quality = NonNullable<ImageSetup["quality"]>;
const QUALITIES: Quality[] = ["low", "medium", "high"];

/** What every layout of the Image View builds on (desktop and tablet here, the phone in IV1c). */
export interface ImageViewModel {
  /** The launcher's composer: no prompt, the buyer's own text. */
  blank: boolean;
  promptId: string | null;
  status: Status;
  /** Reads the prompt again, after "Couldn't load this prompt". */
  reload: () => void;
  /** The prompt's title; "New image" in the blank composer. */
  title: string;
  /** Who made it, as far as known; null while unknown (never "Unknown Artist"). */
  artist: { handle: string | null; name: string | null } | null;
  /** The text stays the artist's: the buyer fills its variables only. */
  premium: boolean;
  /** Signed out, or in on a shared team code: no price, no history, "Log in to generate". */
  guest: boolean;
  /** The minute clock "2h ago" is told against. */
  now: number;

  /** What the T view edits: the artist's text, the buyer's edit of it, the blank composer's own; null on a premium prompt. */
  text: string | null;
  /** A free prompt whose text did not load: nothing can be generated from it. */
  textMissing: boolean;
  /** The buyer changed the artist's wording (Reset is offered). */
  edited: boolean;
  setText: (text: string) => void;
  resetText: () => void;
  /** T ("text") or [ ] ("filled"). */
  view: "text" | "filled";
  setView: (view: "text" | "filled") => void;
  segments: Segment[] | null;
  /** The composer's inputs, in order. */
  fields: Field[];
  variables: PromptVariable[];
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  /** Values loaded from an image: the field may grow, not shrink, until typed in (`release`). PROMPT_KEY is the text's. */
  growOnly: (key: string) => boolean;
  release: (key: string) => void;
  /** Copies what is on screen: the text, the filled text, or a premium prompt's "label: value" lines. */
  copyPrompt: () => void;
  /** "+ Variable": the selected words become a [slot] holding them, and its field takes the focus. */
  addVariable: (range: VariableRange) => void;

  core: GenerationCore;
  /** Every image generator on offer (no free host on a premium prompt), with its price at the current settings. */
  models: CatalogueEntry[];
  modelPrices: Array<GenerationQuote | null>;
  pickModel: (id: string) => void;
  /** Clamped to the generator in use. */
  ratio: string;
  setRatio: (ratio: string) => void;
  resolution: ResolutionTier;
  setResolution: (tier: ResolutionTier) => void;
  /** Aligned with core.tiers. */
  tierPrices: Array<GenerationQuote | null>;
  quality: Quality;
  setQuality: (quality: Quality) => void;
  /** Low, medium, high; empty unless the generator has the lever. */
  qualityPrices: Array<GenerationQuote | null>;
  boost: boolean;
  setBoost: (on: boolean) => void;

  refs: { id: string; src: string }[];
  /** Previews of images still being read. */
  pending: string[];
  /** How many images the generator takes here (at most 4); room left; how many are over a smaller generator's cap. */
  cap: number;
  room: number;
  over: number;
  accept: string;
  addFiles: (files: File[]) => void;
  addNfts: (picks: NftPick[]) => void;
  removeRef: (id: string) => void;
  moveRef: (from: number, to: number) => void;

  /** The job Generate would run now; null without a generator. */
  setup: ImageSetup | null;
  quote: GenerationQuote | null;
  quotePending: boolean;
  /** The Generate chip: "$0.00", the server's total, "…", or none. */
  chip: string | null;
  /** Dimmed still takes the press, which says what is missing. */
  button: { label: string; dimmed: boolean };
  /** The line under Generate; nothing for a paid render, whose price is on the button. */
  cost: string | null;
  /** The balance while it is below the price: Generate turns red, carries it, and its press opens Add funds (Kev, 2026-10-13). */
  short: string | null;
  generate: () => void;
  /** Open while a paid render waits on the low-balance question. */
  funds: { balanceUsd: number; totalUsd: string } | null;
  tryAnyway: () => void;
  closeFunds: () => void;

  jobs: Job<ImageSetup>[];
  /**
   * Regenerate (a finished job: its setup back in the composer, the same job
   * again, handoff §0) and Retry (a failed one goes, its setup runs at the
   * front), checked against the job's own price as Generate is against the chip's.
   */
  again: (job: Job<ImageSetup>, price: JobPrice) => void;
  /** This tab's renders, newest first. */
  queue: Shot[];
  examples: Shot[];
  community: Shot[];
  /** The viewer's own renders of this prompt, none still in the queue. */
  history: Shot[];
  /** Every finished image in page order: what the viewer pages through. */
  finished: Shot[];
  /** The image on the stage. */
  main: Shot | null;
  /** Puts an image on the stage; a job's values load into the fields. */
  select: (shot: Shot) => void;
  /** A finished render was shown (stage or viewer). */
  seen: (shot: Shot) => void;
  /** Takes a render of this tab out of the queue while its request has not gone out (Kev, 2026-10-13). */
  cancel: (shot: Shot) => void;
  historyState: { loading: boolean; failed: boolean; retry: () => void; more: boolean; loadingOlder: boolean; loadOlder: () => void };
  setPublic: (row: GenerationRow, on: boolean) => Promise<void>;

  likes: { count: number; mine: boolean } | null;
  toggleLike: () => void;
  discussion: { data: Discussion | undefined; error: string | null; retry: () => void };
  /** A comment ({body}) or a review ({imageId, rating?, body?}); true once the server took it. */
  post: (payload: { body?: string; rating?: number; imageId?: string }) => Promise<boolean>;
  /** The viewer's own recorded renders of this prompt: what a review may show (Kev, 2026-10-13). */
  reviewable: Shot[];
  /** The review composer opens once the viewer has an image of this prompt (checked here only, plan §5 #19). */
  canPost: boolean;
  /** Saved in any of the viewer's bookmark categories, including before this visit. */
  saved: boolean;
  memberships: readonly Membership[];
  /** BookmarkPicker's onChange. */
  bookmarked: (kind: "added" | "removed", category: string) => void;
}

/* A minute clock for "2h ago": read through the store, never in render. */
const minuteNow = () => Math.floor(Date.now() / 60_000) * 60_000;
const everyMinute = (tick: () => void) => {
  const t = setInterval(tick, 60_000);
  return () => clearInterval(t);
};

/** Focuses a field's input, or its token in the [ ] view, once the render it waits for is in (R11: Generate points at it). */
export function focusField(key: string) {
  requestAnimationFrame(() => {
    const at = document.querySelector<HTMLElement>(`[data-iv-field="${CSS.escape(key)}"]`);
    (at?.matches("button, [contenteditable]") ? at : at?.querySelector<HTMLElement>("textarea, input, button"))?.focus();
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function useImageViewModel(seed: ImageViewSeed | "blank"): ImageViewModel {
  const blank = seed === "blank";
  const s = blank ? null : seed;
  const promptId = s?.promptId ?? null;
  const queryClient = useQueryClient();
  const { access, role, userId } = useBetaAccess();
  const guest = !(access === "ok" && role !== "team");
  const { userKey, payer } = useViewerWallets();
  const now = useSyncExternalStore(everyMinute, minuteNow, () => 0);

  /* ── The prompt. The default fetcher (viewerHeaders) under this key: the
     feed reads its state to drop a card that answered 404. */
  const promptQ = useQuery<{ prompt: PromptRecord }>({ queryKey: [`/api/prompts/${promptId}`], enabled: !!promptId });
  const prompt = promptQ.data?.prompt;
  const status: Status = blank ? "ready" : loadState(promptQ);
  const handle = s?.artist?.handle || null;
  const creatorQ = useQuery<{ creator?: { username?: string; displayName?: string } }>({
    queryKey: [`/api/creators/${prompt?.creator_id}/profile`],
    enabled: !!prompt?.creator_id && !handle,
  });
  const artistHandle = handle ?? creatorQ.data?.creator?.username ?? null;
  const artistName = s?.artist?.name ?? creatorQ.data?.creator?.displayName ?? null;

  const premium = !!prompt && !isFreePrompt(prompt);
  const textMissing = !blank && !!prompt && !premium && prompt.publicPromptText == null;
  const publicText = blank ? "" : premium || textMissing ? null : (prompt?.publicPromptText ?? null);
  const variables = prompt?.promptData?.variables ?? [];

  /* ── The composer. Values are the prompt's defaults under the buyer's own
     edits, derived on every render: nothing is copied into state. */
  const [edited, setEdited] = useState<string | null>(null);
  const [view, setView] = useState<"text" | "filled">("text");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const grow = useGrowOnly();
  const text = edited ?? publicText;
  const segments: Segment[] | null = text === null ? null : parseSegments(text, variables);
  const fields = fieldsFor(variables, segments);
  const values = { ...initialValues(variables), ...overrides };
  const setValue = (key: string, v: string) => setOverrides((o) => ({ ...o, [key]: v }));

  const catalogue = useModelCatalogue();
  const [pick, setPick] = useState("");
  // The generators the artist put on offer (the editor's multi-select); every one before that list existed.
  const offered = offeredModels(prompt?.ai_settings);
  const models = modelOptions(catalogue, premium, offered);
  const modelName = defaultModel({ catalogue, pick, aiModel: prompt?.ai_model, premium, offered });
  const core = useGenerationCore(modelName || undefined);
  const entry = core.entry;
  const [ratioPick, setRatio] = useState("");
  const [resPick, setResolution] = useState("");
  const [quality, setQuality] = useState<Quality>("medium");
  const [boost, setBoost] = useState(false);
  const ratio = core.clampRatio(ratioPick || prompt?.aspect_ratio || "1:1");
  const resolution = core.clampTier(resPick || prompt?.resolution || "2K");

  const [refs, setRefs] = useState<{ id: string; src: string }[]>([]);
  const reads = useReferenceReads();
  const cap = refCap(entry);
  const slots = refSlots(cap, refs.length, reads.pending.length);
  const { accept } = useModelLimits(entry?.id);
  /* The creator's own reference images stand in the slots once their prompt
     is back in the view, in the order it was released with, ready to be
     swapped for others (Kev, 2026-10-13: "weiterhin alle reference images
     gezeigt werden, was ich dann ändern kann"); read into data once, as every
     reference travels. Never over images the viewer added first. */
  const seeded = useRef<string | null>(null);
  const before = prompt?.beforeImages;
  const readRef = reads.read;
  useEffect(() => {
    if (!promptId || !before?.length || seeded.current === promptId) return;
    seeded.current = promptId;
    void Promise.all(before.map(({ url }) =>
      fetch(url).then((res) => (res.ok ? res.blob() : null)).catch(() => null).then((blob) => (blob ? readRef(blob) : null)),
    )).then((data) => {
      const got = data.flatMap((src) => (src ? [{ id: crypto.randomUUID(), src }] : []));
      if (got.length) setRefs((r) => (r.length ? r : got));
    });
  }, [promptId, before, readRef]);

  const composer = {
    promptId: promptId ?? undefined,
    title: prompt?.title,
    publicText,
    edited,
    variables,
    values,
    model: entry,
    resolution,
    aspectRatio: ratio,
    quality,
    boost,
    refs: refs.map((r) => r.src),
  };
  const setup = makeSetup(composer);

  /* ── Prices: the chip prices exactly the job Generate would send; the
     menus price each option at the current settings. Guests get none (the
     quote route needs a session, plan §5 #14). */
  const quote = useComposerQuote(guest || !setup ? null : quoteOf(setup));
  const ask = (m: CatalogueEntry, res: ResolutionTier, q: Quality = quality): QuoteRequest => ({
    promptId: promptId ?? undefined,
    modelId: m.id,
    resolution: res,
    quality: m.supportsQuality ? q : undefined,
    boost: boost && boostAt(m, res),
    referenceImageCount: refs.length,
  });
  const fit = (m: CatalogueEntry) => {
    const tiers = tiersUpTo(m.maxResolution);
    return tiers.includes(resolution) ? resolution : tiers[tiers.length - 1];
  };
  const priced = guest ? [] : models.filter((m) => !m.free).slice(0, 24);
  const pricedQuotes = useServerQuotes(priced.map((m) => ask(m, fit(m))));
  const paidEntry = !guest && entry && !entry.free ? entry : null;
  const tierPrices = useServerQuotes(paidEntry ? core.tiers.map((t) => ask(paidEntry, t.tier)) : []);
  const qualityPrices = useServerQuotes(paidEntry?.supportsQuality ? QUALITIES.map((q) => ask(paidEntry, resolution, q)) : []);

  const holdings = useHoldings(payer);
  const balance = guest ? null : balanceView({ payer, ready: holdings.ready, balance: holdings.balance, free: core.free, quote: quote.quote });

  /* ── The queue. Leaving says where the renders went; the server keeps them all. */
  const queue = useRenderQueue<ImageSetup>({
    freeModelSelected: !guest && entry?.free === true,
    quotaKey: guest ? null : userId,
    toRequest,
    onLeave: (jobs) => {
      const said = leaveSummary(jobs, blank ? "My Gallery" : "History");
      if (said) notify(said);
      void queryClient.invalidateQueries({ queryKey: ["user-generations"] });
    },
  });
  const { jobs, runBatch, markSeen } = queue;
  const own = useOwnRenders({ userKey: guest ? null : userKey, promptId, jobs });

  /* ── Generate: the first reason it cannot go yet, said on the press (R11). */
  const gate = ((): { label: string; why: string | null; field?: Field } => {
    if (guest) return { label: "Log in to generate", why: null };
    if (!setup) return { label: "Pick a generator", why: "Pick a generator first" };
    if (textMissing) return { label: GENERATE, why: "This prompt's text could not load. Try again later." };
    if (reads.loading) return { label: "Loading images…", why: REFS_LOADING };
    if (slots.over) {
      return { label: `Remove ${plural(slots.over, "reference image")}`, why: `${setup.model.name} takes ${cap ? `at most ${plural(cap, "reference image")}` : "no reference images"}` };
    }
    if (quote.unavailable) return { label: "No longer available", why: "This prompt is no longer available" };
    const field = missingRequired(fields, values);
    if (field) return { label: GENERATE, why: `Fill in ${field.label} first`, field };
    const refusal = text === null ? null : promptRefusal(setup.prompt, !setup.model.free);
    if (refusal) return { label: GENERATE, why: refusal };
    if (setup.model.free && !queue.freeQuota) return { label: GENERATE, why: "Checking your daily free image allowance…" };
    if (setup.model.free && queue.freeQuota?.exhausted) return { label: "Choose a paid generator", why: "Your daily free image has been used. Choose a paid generator to keep going." };
    if (!setup.model.free && !quote.quote) return { label: GENERATE, why: quote.pending ? "The price is on its way" : "Price unavailable right now" };
    return { label: GENERATE, why: null };
  })();

  /** A job goes in front of the others; the image on the stage stays (handoff §0), unless there was none. */
  const start = (job: ImageSetup, retried?: string) => {
    setSelected((k) => k ?? main?.key ?? null);
    if (retried) queue.retry(retried);
    else runBatch([job]);
  };
  const [funds, setFunds] = useState<{ balanceUsd: number; totalUsd: string; go: () => void } | null>(null);
  const short = balance?.short ? balance.text : null;
  const generate = () => {
    if (guest) return openLogin();
    // Red button: the balance is below the price, so the press goes to Add funds (Kev, 2026-10-13).
    if (short !== null) return openAddFunds();
    if (gate.why) {
      notify(gate.why);
      if (gate.field) focusField(gate.field.key);
      return;
    }
    const job = makeSetup(composer);
    if (!job) return;
    if (tooLargeToSend(toRequest(job))) return notify(REFS_TOO_LARGE, { tone: "error" });
    start(job);
  };

  // A paid render says nothing under the button: its price is on it (Kev, 2026-10-13).
  const cost = (() => {
    if (guest) return "Sign in to see the price";
    if (!entry) return "Pick a generator";
    if (!entry.free) return null;
    const yours = blank ? "" : "Open prompt · ";
    return queue.freeQuota?.exhausted ? "Your daily free image is used. Pick a paid generator to continue." : queue.note ? `${quotaText(queue.note)} · pick another generator to keep going` : queue.freeQuota ? `${yours}${entry.name} · ${queue.freeQuota.remaining} daily free image available` : "Checking your daily free image allowance…";
  })();

  /** A job's values back into the fields (only growing them); with `settings`, its generator and settings too (Regenerate). */
  const loadSetup = (job: ImageSetup, settings: boolean) => {
    setOverrides(job.values);
    setEdited(job.edited);
    grow.hold([PROMPT_KEY, ...Object.keys(job.values)]);
    if (!settings) return;
    setPick(job.model.name);
    setRatio(job.aspectRatio);
    setResolution(job.resolution);
    if (job.quality) setQuality(job.quality);
    setBoost(job.boost);
    setRefs(job.refs.map((src) => ({ id: crypto.randomUUID(), src })));
  };

  const again = (job: Job<ImageSetup>, price: JobPrice) => {
    if (guest) return openLogin();
    if (job.status === "failed" && job.error?.payment) return queue.retry(job.id);
    const step = againStep(job.setup, price, { payer, ready: holdings.ready, balance: holdings.balance });
    if (step.why) return notify(step.why);
    const retried = job.status === "failed" ? job.id : undefined;
    if (!retried) loadSetup(job.setup, true);
    const go = () => {
      start(job.setup, retried);
      if (!retried) notify("Regenerating with the same setup");
    };
    if (step.funds) return setFunds({ balanceUsd: holdings.balance, totalUsd: step.funds.totalUsd, go });
    go();
  };

  /* ── Images: this tab's renders, the creator's examples, public images
     made with the prompt (none of the viewer's own: those are in the queue
     or the history), and the viewer's history. */
  const imagesQ = useQuery<{ id: string; url: string; thumbnailUrl?: string }[]>({
    queryKey: ["prompt-public-images", promptId],
    queryFn: async () => {
      const res = await fetch(`/api/prompts/${encodeURIComponent(promptId as string)}/images`, { headers: viewerHeaders() });
      return res.ok ? ((await res.json()).images ?? []) : [];
    },
    enabled: !!promptId,
    staleTime: 30_000,
  });
  const jobShots: Shot[] = jobs.map((j) => ({
    key: `job:${j.id}`, kind: "job", src: j.imageUrl, thumb: j.imageUrl, original: j.imageUrl,
    ratio: j.setup.aspectRatio, job: j, record: j.imageUrl ? recordOf(own.rows, j.imageUrl) : undefined,
  }));
  const examples: Shot[] = (prompt?.showcaseImages ?? []).map(({ url }, i) => ({
    key: `example:${i}`, kind: "example", src: url, thumb: url, original: url, ratio: prompt?.aspect_ratio ?? null,
  }));
  /* A render of this tab joins the history as soon as it is recorded (Kev,
     2026-10-13): the rail's entry is then the queue's own shot, same key, with
     the row's time, so picking either lands on one stage image. */
  const history: Shot[] = own.history.map((r) => {
    const queuedShot = jobShots.find((s) => s.record?.id === r.id);
    return queuedShot ? { ...queuedShot, createdAt: r.created_at } : {
      key: `history:${r.id}`, kind: "history", src: r.image_urls[0] ?? r.image_url ?? undefined,
      thumb: r.thumbnail_url ?? r.image_urls[0] ?? r.image_url ?? undefined, original: r.image_url ?? r.image_urls[0],
      ratio: null, record: r, createdAt: r.created_at,
    };
  });
  // Public images made with the prompt; the viewer's own among them are their history entries (publicShots).
  const community: Shot[] = publicShots(imagesQ.data ?? [], own.rows, history, (im) => (
    { key: `community:${im.id}`, kind: "community", src: im.url, thumb: im.thumbnailUrl || im.url, original: im.url, ratio: null, publicId: im.id }
  ));
  const all = [...jobShots, ...examples, ...community, ...history];

  const [selected, setSelected] = useState<string | null>(null);
  const main =
    all.find((x) => x.key === selected) ??
    (selected?.startsWith("job:") ? jobShots[0] : undefined) ?? // a retried job's successor
    examples[0] ?? jobShots[0] ?? null;

  /** Marks a finished render seen once it is on the stage or in the viewer. */
  const seen = (x: Shot) => {
    if (x.job?.status === "ready" && !x.job.seen) markSeen(x.job.id);
  };
  /* The image brings its own generator and settings along (Kev, 2026-10-13:
     "the generator that the image was created with as the default, with the
     ratios etc"): a job its whole setup, a creator example the prompt's own,
     a recorded render what GET /api/generations says it was made with. */
  const select = (x: Shot) => {
    setSelected(x.key);
    const recorded = x.record?.settings;
    if (x.job) loadSetup(x.job.setup, true);
    else if (recorded) {
      const own = recorded.modelId ? catalogue.find((m) => m.id === recorded.modelId) : undefined;
      if (own) setPick(own.name);
      setRatio(recorded.aspectRatio ?? "");
      setResolution(recorded.resolution ?? "");
      setBoost(recorded.boost);
    } else if (x.kind === "example") {
      setPick("");
      setRatio("");
      setResolution("");
    }
    seen(x);
  };

  /** Shows one of the viewer's images to others, or hides it again; the rows that show it follow. */
  const setPublic = async (row: GenerationRow, on: boolean) => {
    const res = await fetch(`/api/images/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ visibility: on ? "public" : "private" }),
    }).catch(() => null);
    if (!res?.ok) {
      const d = await res?.json().catch(() => null);
      return notify(d?.error ?? "Couldn't change who sees this image", { tone: "error" });
    }
    void queryClient.invalidateQueries({ queryKey: ["user-generations"] });
    void queryClient.invalidateQueries({ queryKey: ["prompt-public-images"] });
  };

  /* ── Likes, comments and ratings. */
  const likesKey = ["prompt-likes", promptId];
  const likesQ = useQuery({
    queryKey: likesKey,
    queryFn: () => loadLikes(promptId as string, sessionAuthHeaders()),
    enabled: !!promptId,
  });
  const toggleLike = async () => {
    const was = likesQ.data;
    if (!promptId || !was) return;
    queryClient.setQueryData(likesKey, { count: was.count + (was.mine ? -1 : 1), mine: !was.mine });
    const res = await fetch(`/api/prompts/${encodeURIComponent(promptId)}/likes`, { method: "POST", headers: sessionAuthHeaders() }).catch(() => null);
    const d = await res?.json().catch(() => null);
    if (res?.ok && d) return queryClient.setQueryData(likesKey, { count: Number(d.count) || 0, mine: !!d.mine });
    queryClient.setQueryData(likesKey, was);
    if (res?.status === 401) notify("Sign in to like.");
    else notify(d?.error ?? "Couldn't save the like", { tone: "error" });
  };

  const talkQ = useQuery<Discussion>({
    queryKey: ["prompt-comments", promptId],
    queryFn: () => loadDiscussion(promptId as string),
    enabled: !!promptId,
    staleTime: 30_000,
  });
  const post = async (payload: { body?: string; rating?: number; imageId?: string }): Promise<boolean> => {
    const res = await fetch(`/api/prompts/${encodeURIComponent(promptId as string)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify(payload),
    }).catch(() => null);
    const d = await res?.json().catch(() => null);
    if (res?.ok) {
      notify(payload.rating || payload.imageId ? (d?.updated ? "Review updated" : "Review posted") : "Comment posted");
      void talkQ.refetch();
      return true;
    }
    if (res?.status === 401) notify("Sign in to comment");
    else notify(res?.status === 429 ? "Slow down a moment" : d?.error ?? "Couldn't post that. Try again.", { tone: "error" });
    return false;
  };

  const bookmarks = useBookmarkIndex(!guest && !!promptId);
  const memberships = !guest && promptId ? bookmarks?.get(promptId) ?? [] : [];

  return {
    blank,
    promptId,
    status,
    reload: () => void promptQ.refetch(),
    title: blank ? "New image" : (prompt?.title ?? s?.title ?? ""),
    artist: artistHandle || artistName ? { handle: artistHandle, name: artistName } : null,
    premium,
    guest,
    now,

    /* The prompt and the buyer's values. */
    text,
    textMissing,
    edited: edited !== null,
    setText: (t: string) => setEdited(t),
    resetText: () => setEdited(null),
    view,
    setView,
    segments,
    fields,
    variables,
    values,
    setValue,
    growOnly: grow.isHeld,
    release: grow.release,
    copyPrompt: () =>
      copyText(clipboardText({ view, text, variables, values }), text === null ? "Your values copied" : "Prompt copied"),
    addVariable: (range: VariableRange) => {
      const t = text ?? "";
      setEdited(`${t.slice(0, range.start)}[${range.name}]${t.slice(range.end)}`);
      const key = matchVariable(variables, range.name)?.name ?? range.name;
      setValue(key, range.name);
      focusField(key);
    },

    /* Generator and settings. */
    core,
    models,
    modelPrices: models.map((m) => pricedQuotes[priced.indexOf(m)] ?? null),
    pickModel: (id: string) => setPick(catalogue.find((m) => m.id === id)?.name ?? ""),
    ratio,
    setRatio,
    resolution,
    setResolution: (t: ResolutionTier) => setResolution(t),
    tierPrices,
    quality,
    setQuality,
    qualityPrices,
    boost,
    setBoost,

    /* References. */
    refs,
    pending: reads.pending,
    cap,
    room: slots.room,
    over: slots.over,
    accept,
    addFiles: (files: File[]) =>
      files.slice(0, slots.room).forEach(async (f) => {
        const src = await reads.read(f);
        if (src) setRefs((r) => [...r, { id: crypto.randomUUID(), src }]);
        else notify("Couldn't read that image", { tone: "error" });
      }),
    addNfts: (picks: NftPick[]) =>
      picks.forEach(async (p) => {
        const src = await reads.read(p);
        if (src) setRefs((r) => [...r, { id: crypto.randomUUID(), src }]);
        else notify("NFT image unavailable", { tone: "error" });
      }),
    removeRef: (id: string) => setRefs((r) => r.filter((x) => x.id !== id)),
    moveRef: (from: number, to: number) =>
      setRefs((r) => {
        const next = [...r];
        next.splice(to, 0, ...next.splice(from, 1));
        return next;
      }),

    /* Price and Generate. */
    setup,
    quote: quote.quote,
    quotePending: quote.pending,
    chip: chipLabel({ signedIn: !guest, free: core.free, quote: quote.quote, pending: quote.pending }),
    button: { label: gate.label, dimmed: gate.why !== null },
    cost,
    short,
    generate,
    funds: funds && { balanceUsd: funds.balanceUsd, totalUsd: funds.totalUsd },
    tryAnyway: () => funds?.go(),
    closeFunds: () => setFunds(null),

    /* The queue and the images. */
    jobs,
    again,
    queue: jobShots,
    examples,
    community,
    history,
    // Each key once: a recorded render is in the queue and in the history under the same key.
    finished: [...new Map(all.filter((x) => x.src).map((x) => [x.key, x])).values()],
    main,
    select,
    seen,
    cancel: (shot) => { if (shot.job) queue.cancel(shot.job.id); },
    historyState: { loading: own.loading, failed: own.failed, retry: own.retry, more: own.more, loadingOlder: own.loadingOlder, loadOlder: own.loadOlder },
    setPublic,

    /* Likes, discussion, bookmark. */
    likes: likesQ.data ?? null,
    toggleLike,
    discussion: { data: talkQ.data, error: talkQ.error?.message ?? null, retry: () => void talkQ.refetch() },
    post,
    // Recorded, so each carries its generated_images id, which the server checks against the reviewer.
    reviewable: all.filter((x) => x.record && x.thumb),
    canPost: !guest && hasGenerated(jobs, own.history),
    saved: memberships.length > 0,
    memberships,
    bookmarked: (kind: "added" | "removed", category: string) => {
      notify(kind === "added" ? `Saved to ${category}` : `Removed from ${category}`);
    },
  };
}

/**
 * Regenerate (a finished job) or Retry (a failed one that cannot have been
 * charged); null for any other job. Its own server price, which the button
 * shows and waits for (spec-imageview-mobile D10): the chip prices the
 * composer, which may have moved on since the job ran.
 */
export function useAgain(m: ImageViewModel, job: Job<ImageSetup> | undefined) {
  const existingPayment = job?.status === "failed" && !!job.error?.payment;
  const ok = !!job && (job.status === "ready" || job.error?.charged === "no" || existingPayment);
  const price = useComposerQuote(ok && !existingPayment && !m.guest ? quoteOf(job.setup) : null);
  if (!ok) return null;
  const free = job.setup.model.free;
  return {
    label: existingPayment ? "Check payment" : job.status === "ready" ? "Regenerate" : "Retry",
    price: existingPayment ? null : chipLabel({ signedIn: !m.guest, free, quote: price.quote, pending: price.pending }),
    ready: existingPayment || free || price.quote !== null,
    press: () => m.again(job, price),
  };
}
