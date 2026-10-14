"use client";

/** Server-priced escrow checkout. A submitted deposit moves funds into escrow; retries reuse its original intent. */
import { sessionAuthHeaders } from "@/lib/session-headers";

/** The models table stores display names; pricing keys are their slugs. */
/* Re-exported, not redefined: the server enforces the same key and cannot
   import this file (see lib/generation/model-family.ts). */
export { toModelFamily } from "@/lib/generation/model-family";

/** Integer micro-USDC (string, as the API serialises u64s) → display dollars. */
export function microToUsd(micro: string | number): string {
  const n = typeof micro === "string" ? Number(micro) : micro;
  if (!Number.isFinite(n)) return "0.00";
  return (n / 1_000_000).toFixed(n % 10_000 === 0 ? 2 : 3);
}

export interface GenerationQuote {
  /** Integer micro-USDC, for totals over several images. */
  totalMicro: number;
  totalUsd: string;
  networkFeeUsd: string;
  artistUsd: string;
  expiresAt: string;
  appliedRule: { name: string } | null;
}

/** The sum of settings the server prices and the intent stores (lib/payments/generation-settings.ts). */
export interface QuoteRequest {
  /** Absent for the buyer's own prompt (the editors). */
  promptId?: string;
  /** The exact catalogue row the user selected. */
  modelId: string;
  resolution: "1K" | "2K" | "4K";
  /** Boost reprices the model leg at the vendor-direct route's real cost. */
  boost?: boolean;
  quality?: "low" | "medium" | "high";
  referenceImageCount?: number;
}

/** Null on any failure: a missing quote greys the paid button, never fakes a price. */
export async function fetchGenerationQuote(req: QuoteRequest): Promise<GenerationQuote | null> {
  try {
    const res = await fetch("/api/payments/generation/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify(req),
    });
    if (res.status === 404) throw new PromptUnavailable();
    if (!res.ok) return null;
    const json = (await res.json()) as { quote?: QuoteBody };
    return json.quote ? toQuote(json.quote) : null;
  } catch (e) {
    if (e instanceof PromptUnavailable) throw e;
    return null;
  }
}

/**
 * The quote's "not for sale": the prompt was taken down, deleted or never
 * listed. Unlike every other missing quote, waiting will not bring this one,
 * so the buyer is told instead of shown a price that never loads.
 */
export class PromptUnavailable extends Error {
  constructor() {
    super("This prompt is no longer available.");
    this.name = "PromptUnavailable";
  }
}

interface QuoteBody {
  expiresAt: string;
  breakdown: { totalAmount: string; networkFee: string; artistAmount: string };
  appliedRule: { name: string } | null;
}

function toQuote(q: QuoteBody): GenerationQuote {
  return {
    totalMicro: Number(q.breakdown.totalAmount),
    totalUsd: microToUsd(q.breakdown.totalAmount),
    networkFeeUsd: microToUsd(q.breakdown.networkFee),
    artistUsd: microToUsd(q.breakdown.artistAmount),
    expiresAt: q.expiresAt,
    appliedRule: q.appliedRule,
  };
}

/**
 * Many quotes in one request, in order; null where the server gave none.
 * What every picker shows next to its options (Kev, 2026-10-02: "ich
 * brauche safe überall den server-quote").
 */
export async function fetchGenerationQuotes(reqs: QuoteRequest[]): Promise<Array<GenerationQuote | null>> {
  if (!reqs.length) return [];
  try {
    const res = await fetch("/api/payments/generation/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ items: reqs.slice(0, 24) }),
    });
    // A refused request carries no quotes, so every option reads null.
    const json = ((await res.json().catch(() => null)) ?? {}) as { quotes?: Array<QuoteBody | { error: string }> };
    return reqs.map((_, i) => {
      const q = json.quotes?.[i];
      return q && "breakdown" in q ? toQuote(q) : null;
    });
  } catch {
    return reqs.map(() => null);
  }
}

export type EscrowDepositState = "prepared" | "submitting" | "submitted" | "funded" | "expired";
export interface EscrowUnitStatus {
  unit_index: number;
  state: "pending" | "running" | "delivered" | "failed";
  generation_id: string | null;
  imageUrl?: string;
}
export interface EscrowCheckout {
  intentId: string;
  units: number;
  paymentScheme: "escrow";
  state: EscrowDepositState | "uncertain";
  unitStatuses?: EscrowUnitStatus[];
  /** Public signed wire, retained only to retry the SAME deposit after a lost submit response. */
  signedTransaction?: string;
}
export type FundedEscrowCheckout = EscrowCheckout & { state: "funded" };
export class CheckoutError extends Error {
  constructor(readonly step: "intent" | "authorize" | "sign" | "submit" | "status", message: string,
    readonly payment?: EscrowCheckout) {
    super(message);
    this.name = "CheckoutError";
  }
}
async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json", ...sessionAuthHeaders() }, body: JSON.stringify(body),
  });
}
/** Base64 transaction in, the same transaction with the buyer's signature out. */
export type PaymentSigner = (transaction: string) => Promise<string>;
export type PaymentCheckpoint = (payment: EscrowCheckout) => void | Promise<void>;
async function checkpointPayment(checkpoint: PaymentCheckpoint | undefined, payment: EscrowCheckout) {
  try { await checkpoint?.(payment); }
  catch { throw new CheckoutError("submit", "The payment could not be saved safely. Check its status before continuing.", payment); }
}
const errorOf = async (res: Response, fallback: string) => {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : fallback;
};
const PENDING_PAYMENT = "Your payment is still being checked. Check its status before making another payment.";
const STATES: EscrowDepositState[] = ["prepared", "submitting", "submitted", "funded", "expired"];
async function statusBody(res: Response, payment: EscrowCheckout): Promise<EscrowCheckout> {
  if (!res.ok) throw new CheckoutError("status", PENDING_PAYMENT, payment);
  const body = await res.json().catch(() => null) as { intentId?: string; paymentScheme?: string; state?: EscrowDepositState; funded?: boolean; units?: EscrowUnitStatus[] } | null;
  if (!body || body.intentId !== payment.intentId || body.paymentScheme !== "escrow" || !body.state ||
      !STATES.includes(body.state) || body.funded !== (body.state === "funded")) {
    throw new CheckoutError("status", PENDING_PAYMENT, payment);
  }
  if (body.units !== undefined && (!Array.isArray(body.units) || body.units.some(unit => !unit ||
      !Number.isInteger(unit.unit_index) || unit.unit_index < 0 || unit.unit_index >= payment.units ||
      !["pending", "running", "delivered", "failed"].includes(unit.state) ||
      (unit.state === "delivered" ? typeof unit.generation_id !== "string" : unit.generation_id !== null) ||
      (unit.imageUrl !== undefined && (unit.state !== "delivered" || typeof unit.imageUrl !== "string" || !unit.imageUrl.startsWith("https://")))) ||
      new Set(body.units.map(unit => unit.unit_index)).size !== body.units.length)) {
    throw new CheckoutError("status", PENDING_PAYMENT, payment);
  }
  return { ...payment, state: body.state, ...(body.units ? { unitStatuses: body.units } : {}) };
}
async function submitSameDeposit(payment: EscrowCheckout, onPayment?: PaymentCheckpoint): Promise<EscrowCheckout> {
  if (!payment.signedTransaction) throw new CheckoutError("submit", PENDING_PAYMENT, payment);
  await checkpointPayment(onPayment, payment);
  try {
    const res = await post("/api/payments/generation/submit", {
      intentId: payment.intentId, signedTransaction: payment.signedTransaction,
    });
    const current = await statusBody(res, payment);
    await checkpointPayment(onPayment, current);
    return current;
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError("submit", PENDING_PAYMENT, { ...payment, state: "uncertain" });
  }
}
/**
 * How long a submitted deposit is asked about again before the order is left
 * as pending, 30 s in all. A Solana confirmation takes a few seconds: asking
 * once, right after the submit, found nearly every deposit unconfirmed, so
 * the buyer had paid into the escrow and got "still being checked" instead of
 * the image until they pressed Check payment (Kev's first browser payment,
 * 2026-10-13).
 */
export const CONFIRM_WAITS_MS = [1000, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 5000, 5000];
const sleep = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms); });
/** Never opens an intent or a wallet. Resume only the already signed deposit. */
export async function resumePaidGeneration(payment: EscrowCheckout, onPayment?: PaymentCheckpoint): Promise<FundedEscrowCheckout> {
  let current: EscrowCheckout;
  try {
    current = await checkPaidGenerationStatus(payment);
    if (current.state === "prepared" && current.signedTransaction) current = await submitSameDeposit(current, onPayment);
    // On its way to the chain: wait for the receipt. Every other state is an answer already.
    for (const ms of CONFIRM_WAITS_MS) {
      if (current.state !== "submitted" && current.state !== "submitting") break;
      await sleep(ms);
      current = await checkPaidGenerationStatus(current);
    }
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError("status", PENDING_PAYMENT, payment);
  }
  if (current.state === "expired") {
    throw new CheckoutError("status", "This payment has expired. Check your balance and payment history before starting another order.", current);
  }
  if (current.state !== "funded") throw new CheckoutError("status", PENDING_PAYMENT, current);
  await checkpointPayment(onPayment, current);
  return { ...current, state: "funded" };
}
const CANCELLED = "Cancelled before anything was charged.";
/**
 * One signed escrow deposit for every paid image in this click. `abandoned`
 * is asked before each step up to the submit: once true the line stops cold,
 * and a signature already given is never submitted (Kev, 2026-10-13).
 */
export async function authorizePaidGeneration(req: QuoteRequest, sign: PaymentSigner, units = 1, onPayment?: PaymentCheckpoint,
  abandoned?: () => boolean): Promise<FundedEscrowCheckout> {
  if (!Number.isInteger(units) || units < 1 || units > 24) throw new CheckoutError("intent", "Choose between one and twenty-four images.");
  const unless = (step: CheckoutError["step"]) => { if (abandoned?.()) throw new CheckoutError(step, CANCELLED); };
  unless("intent");
  let intentRes: Response;
  try { intentRes = await post("/api/payments/generation/intent", req); }
  catch { throw new CheckoutError("intent", "Could not prepare the payment. Please try again."); }
  if (!intentRes.ok) throw new CheckoutError("intent", await errorOf(intentRes, "Could not prepare the payment"));
  const intentBody = await intentRes.json().catch(() => null) as { intent?: { id?: string } } | null;
  const intentId = intentBody?.intent?.id;
  if (!intentId) throw new CheckoutError("intent", "Could not prepare the payment");
  unless("authorize");
  let authRes: Response;
  try { authRes = await post("/api/payments/generation/authorize", { intentId, units }); }
  catch { throw new CheckoutError("authorize", "Could not build the payment. Please try again."); }
  if (!authRes.ok) throw new CheckoutError("authorize", await errorOf(authRes, "Could not build the payment"));
  const prepared = await authRes.json().catch(() => null) as { intentId?: string; transaction?: string; units?: number; paymentScheme?: string } | null;
  if (!prepared?.transaction || prepared.intentId !== intentId || prepared.units !== units || prepared.paymentScheme !== "escrow") {
    throw new CheckoutError("authorize", "Could not build the payment");
  }
  unless("sign");
  let signed: string;
  try { signed = await sign(prepared.transaction); }
  catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError("sign", error instanceof Error && /reject|denied|cancel/i.test(error.message)
      ? "Signing was cancelled. Nothing was charged." : "The wallet could not sign. Nothing was charged.");
  }
  // Taken back while the wallet was open: the signature goes nowhere.
  unless("sign");
  const payment = await submitSameDeposit({ intentId, units, paymentScheme: "escrow", state: "uncertain", signedTransaction: signed }, onPayment);
  if (payment.state === "funded") return { ...payment, state: "funded" };
  return resumePaidGeneration(payment, onPayment);
}
/** Close unstarted units; already admitted generations may finish. */
export async function cancelPaidGeneration(payment: EscrowCheckout): Promise<void> {
  try {
    const res = await post("/api/payments/generation/cancel", { intentId: payment.intentId });
    if (!res.ok) throw new CheckoutError("status", "The remaining images could not be cancelled yet. Check the payment status.", payment);
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError("status", "The remaining images could not be cancelled yet. Check the payment status.", payment);
  }
}
export interface FreeGenerationQuota { used: number; limit: number; remaining: number; exhausted: boolean; resetsAt: string }
/** Unknown quota never becomes a fabricated free allowance. */
export async function fetchFreeGenerationQuota(): Promise<FreeGenerationQuota | null> {
  try {
    const res = await fetch("/api/generate-free/quota", { headers: sessionAuthHeaders(), cache: "no-store" });
    if (!res.ok) return null;
    const body = await res.json() as { freeQuota?: FreeGenerationQuota };
    const q = body.freeQuota;
    return q && Number.isInteger(q.used) && q.used >= 0 && q.limit === 1 &&
      Number.isInteger(q.remaining) && q.remaining >= 0 && q.remaining <= q.limit &&
      q.remaining === Math.max(0, q.limit - q.used) && q.exhausted === (q.remaining === 0) && typeof q.resetsAt === "string" ? q : null;
  } catch { return null; }
}
export type PendingEscrowPayment = EscrowCheckout & { unitIndex: number; generationSubmitted: boolean };
const pendingKey = (owner: string) => "enki-pending-escrow:v1:" + owner;
/** Persist public payment identity only. Draft prompts and reference images are not stored here. */
export function storePendingEscrowPayments(storage: Pick<Storage, "setItem" | "removeItem">,
  owner: string, payments: PendingEscrowPayment[] | null): boolean {
  try {
    if (!payments?.length) storage.removeItem(pendingKey(owner));
    else storage.setItem(pendingKey(owner), JSON.stringify(payments.map(payment => ({
      intentId: payment.intentId, units: payment.units, paymentScheme: payment.paymentScheme,
      state: payment.state, signedTransaction: payment.signedTransaction,
      unitIndex: payment.unitIndex, generationSubmitted: payment.generationSubmitted,
    }))));
    return true;
  } catch { return false; }
}
export function readPendingEscrowPayments(storage: Pick<Storage, "getItem">, owner: string): PendingEscrowPayment[] {
  try {
    const stored: unknown = JSON.parse(storage.getItem(pendingKey(owner)) ?? "[]");
    if (!Array.isArray(stored) || stored.length > 24 || stored.some(payment => !payment ||
        typeof payment.intentId !== "string" || !payment.intentId || !Number.isInteger(payment.units) || payment.units < 1 || payment.units > 24 ||
        payment.paymentScheme !== "escrow" || ![...STATES, "uncertain"].includes(payment.state) ||
        !Number.isInteger(payment.unitIndex) || payment.unitIndex < 0 || payment.unitIndex >= payment.units ||
        typeof payment.generationSubmitted !== "boolean" ||
        (payment.signedTransaction !== undefined && typeof payment.signedTransaction !== "string") ||
        payment.intentId !== stored[0].intentId || payment.units !== stored[0].units) ||
        new Set(stored.map(payment => payment.unitIndex)).size !== stored.length) return [];
    return stored;
  } catch { return []; }
}

/** Read-only recovery after reload: never submits or rebuilds a deposit. */
export async function checkPaidGenerationStatus(payment: EscrowCheckout): Promise<EscrowCheckout> {
  try {
    const res = await fetch("/api/payments/generation/status?intentId=" + encodeURIComponent(payment.intentId), { headers: sessionAuthHeaders(), cache: "no-store" });
    return await statusBody(res, payment);
  } catch (error) {
    if (error instanceof CheckoutError) throw error;
    throw new CheckoutError("status", PENDING_PAYMENT, payment);
  }
}
