/**
 * The render queue every generate surface shares (plan §1.3; handoff §0
 * "Render-Queue (überall gleich)"): one job model, one reducer, and one
 * mapping from a generation's outcome to what the user is told. Only the
 * `setup` a job carries is surface-specific.
 */
import type { GenerationOutcome, GenerationPayment } from "@/lib/generation/run-generation";
import type { SignState } from "./serial-signer";

export type Job<S> = {
  /** Made in the click handler, never in render. */
  id: string;
  createdAt: number;
  status: "rendering" | "ready" | "failed";
  /** Everything needed to run the same job again. */
  setup: S;
  /** https (stored) or data: (the store missed). */
  imageUrl?: string;
  /** Measured by the free route only. */
  size?: { w: number; h: number };
  /** `message` is the whole sentence shown for the failure. */
  error?: { message: string; charged: "no" | "unknown"; payment?: GenerationPayment };
  payment?: GenerationPayment;
  seen: boolean;
};

export type QueueAction<S> =
  | { type: "enqueue"; id: string; createdAt: number; setup: S }
  | { type: "payment"; id: string; payment: GenerationPayment }
  | { type: "resolve"; id: string; imageUrl: string; size?: { w: number; h: number } }
  | { type: "fail"; id: string; error: NonNullable<Job<S>["error"]> }
  | { type: "drop"; id: string }
  | { type: "seen"; id: string }
  | { type: "restore"; jobs: Job<S>[] };

const INTERRUPTED = { message: "Interrupted — the image may be in your gallery", charged: "unknown" } as const;

/** The job with this id replaced by `edit(job)`; the same array when there is none or `edit` declines. */
function update<S>(jobs: Job<S>[], id: string, edit: (j: Job<S>) => Job<S> | null): Job<S>[] {
  const i = jobs.findIndex((j) => j.id === id);
  const next = i < 0 ? null : edit(jobs[i]);
  return next ? jobs.map((j, k) => (k === i ? next : j)) : jobs;
}

export function queueReducer<S>(jobs: Job<S>[], a: QueueAction<S>): Job<S>[] {
  switch (a.type) {
    case "enqueue":
      // New jobs go first and nothing else moves (handoff §0).
      return [{ id: a.id, createdAt: a.createdAt, setup: a.setup, status: "rendering", seen: false }, ...jobs];
    case "payment":
      return update(jobs, a.id, j => j.status === "rendering" ? { ...j, payment: a.payment } : null);
    case "resolve":
      // Only a rendering job ends, and only once.
      return update(jobs, a.id, (j) => (j.status === "rendering" ? { ...j, status: "ready", imageUrl: a.imageUrl, size: a.size } : null));
    case "fail":
      return update(jobs, a.id, (j) => (j.status === "rendering" ? { ...j, status: "failed", error: a.error } : null));
    case "drop":
      return jobs.filter((j) => j.id !== a.id);
    case "seen":
      return update(jobs, a.id, (j) => (j.status === "ready" && !j.seen ? { ...j, seen: true } : null));
    case "restore": {
      // Saved jobs still rendering never got their answer, but may have been made.
      const have = new Set(jobs.map((j) => j.id));
      const saved = a.jobs.filter((j) => !have.has(j.id));
      return [...jobs, ...saved.map((j): Job<S> => (j.status === "rendering" ? { ...j, status: "failed", error: j.payment ? { ...INTERRUPTED, payment: j.payment } : INTERRUPTED } : j))];
    }
  }
}

/** What the viewer pages through: the finished renders, in queue order. */
export const viewerList = <S>(jobs: Job<S>[]) => jobs.filter((j) => j.status === "ready");

/** The toast when the page is left, or null when there is nothing to say. Failed jobs never count. */
export function leaveSummary(jobs: Job<unknown>[], place = "History"): string | null {
  const ready = jobs.filter((j) => j.status === "ready").length;
  const rendering = jobs.filter((j) => j.status === "rendering").length;
  const still = `${rendering} still rendering`;
  if (ready) return `${ready} render${ready === 1 ? "" : "s"} saved to ${place}${rendering ? ` · ${still}` : ""}`;
  return rendering ? `${still} · finished ones land in ${place}` : null;
}

export type FreeQuota = { used: number; limit: number };

/** The one wording for a used-up free quota, in the cost line and the toast. */
export const quotaText = ({ used, limit }: FreeQuota) => `Free renders used up (${used} of ${limit})`;

export type Settlement = {
  action: QueueAction<never>;
  toast?: string;
  /** A free render needs an account: open the login. */
  login?: boolean;
  /** The free quota is used up: the cost line says so. */
  note?: FreeQuota;
  /** A paid render arrived: re-read the balance. */
  refresh?: boolean;
};

const CONNECTION_LOST = "Connection lost · if the image was made it appears in your gallery, charged only then";

/**
 * What one finished generation does to the queue and tells the user (plan
 * §1.3 table). `sign` is what this job's signer did. The paid route signs
 * before it generates, and the server voids the payment on every failure it
 * answers; so a signed job is uncertain only once its generation request
 * was sent. Older callers without a phase stay conservative. A cancel is
 * not a failed render: the job goes.
 */
export function settle(id: string, o: GenerationOutcome, sign: SignState): Settlement {
  if (o.ok) {
    const { width: w, height: h } = o.data;
    const size = typeof w === "number" && typeof h === "number" ? { w, h } : undefined;
    return { action: { type: "resolve", id, imageUrl: o.imageUrl, size }, refresh: sign === "signed" || !!o.payment };
  }
  const drop = { type: "drop", id } as const;
  // The words authorizePaidGeneration tells a cancel apart by.
  if (sign === "threw" && /reject|denied|cancel/i.test(o.error)) {
    return { action: drop, toast: "Cancelled in your wallet · nothing was charged" };
  }
  if (o.payment) {
    const message = "Your payment or refund is still being checked. " + o.error;
    return { action: { type: "fail", id, error: { message, charged: "unknown", payment: o.payment } }, toast: message, refresh: true };
  }
  if (o.status === 401 && o.data?.signInRequired) return { action: drop, login: true };
  if (o.status === 402 && o.data?.freeQuotaExhausted) {
    const note = { used: Number(o.data.used), limit: Number(o.data.limit) };
    return { action: drop, note, toast: quotaText(note) };
  }
  const fail = (charged: "no" | "unknown", message: string): Settlement => ({
    action: { type: "fail", id, error: { message, charged } },
    toast: message,
  });
  if (sign === "signed" && o.status === undefined && (o.phase === undefined || o.phase === "generation")) return fail("unknown", CONNECTION_LOST);
  return fail("no", `${o.status === 429 ? "Busy right now" : "Render failed"} · not charged · ${o.error}`);
}

/** Retry a pending deposit as a group; an already sent image request must be reconciled, never replayed. */
export function retryPlan<S>(jobs: Job<S>[], id: string): { jobs: Job<S>[]; resume?: GenerationPayment[] } | { reason: string } | null {
  const job = jobs.find(item => item.id === id);
  if (job?.status !== "failed") return null;
  const payment = job.error?.payment;
  if (payment) {
    if (payment.state === "expired") return { reason: "Check your gallery and payment history before placing another order. This request will not be sent twice." };
    const pending = jobs.filter(item => item.status === "failed" && item.error?.payment?.intentId === payment.intentId);
    return { jobs: pending, resume: pending.map(item => item.error!.payment!) };
  }
  if (job.error?.charged === "unknown") return { reason: "Check your gallery and payment history before placing another order. This request will not be sent twice." };
  return { jobs: [job] };
}
