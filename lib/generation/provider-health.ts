/**
 * Automatic failover between routes.
 *
 * The cheapest route is only the best route while it answers. This watches
 * each route, drops to the fallback when one stops answering, and comes back
 * on its own — so a buyer gets the good price when it is available and an
 * image regardless.
 *
 * ── The unit is the ROUTE, not the provider ─────────────────────────────
 * An aggregator hosts each model on a different upstream. AceData runs
 * nano-banana-pro through Google's own channel and gpt-image-2 through a
 * reverse channel their own docs distinguish from the "official, stable and
 * compliant" one. Those fail independently, so health is keyed per
 * model+provider row.
 *
 * The exception is failures that are statements about the ACCOUNT rather than
 * the model — a dead key, an empty balance, an unreachable host. Those open
 * every route of that provider at once, because rediscovering them model by
 * model costs a real customer a real generation each time.
 *
 * ── Why the probe is free, and why that changes the design ──────────────
 * An x402 provider quotes its price with an HTTP 402 before any payment
 * exists. That handshake runs no inference and settles nothing, so it is a
 * perfect liveness check: it proves the endpoint answers AND returns the
 * current price, for nothing. Recovery does not have to be time-based
 * guesswork — the breaker can ask.
 *
 * ── The failure that must NOT open the breaker ──────────────────────────
 * A prompt refused for content is the provider working correctly. Counting it
 * would let one policy-violating prompt disable a model for every user.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Consecutive infrastructure failures before a route's breaker opens. */
export const FAILURE_THRESHOLD = 3;

/** While open, probe at most this often — a dead host must not be hammered. */
export const PROBE_COOLDOWN_MS = 30_000;

export type FailureKind = "infrastructure" | "content" | "request" | "config";
export type FailureScope = "route" | "provider";

export interface Classification {
  kind: FailureKind;
  /**
   * "provider" means every route of this provider is affected. Those are
   * unambiguous statements about the account, so they open immediately rather
   * than counting to the threshold: a revoked key does not get better on the
   * second attempt.
   */
  scope: FailureScope;
}

/**
 * What a failure says about the route, and how widely it applies.
 *
 * Getting this wrong is expensive in both directions: too broad and a bad
 * prompt takes a model down for everyone, too narrow and we keep routing
 * paying customers into a dead host.
 */
export function classifyFailure(message: string, status?: number): Classification {
  const m = message.toLowerCase();

  // This deployment has no key for the provider ("OPENAI_API_KEY is not set").
  // The host is fine, and breaker state lives in a database other deployments
  // share: a developer environment without the key must never take
  // production's routes down (ENV-01).
  if (/ is not set\b|not configured/.test(m)) return { kind: "config", scope: "route" };

  // Content refusals — the provider answered, and the answer was no.
  if (
    /content[_ ]policy|safety|moderation|blocked|prohibited|nsfw|violat/.test(m) &&
    !/rate|quota|credit|balance/.test(m)
  ) {
    return { kind: "content", scope: "route" };
  }

  // Account-wide: the credential or the balance, not this model.
  // Checked before the generic "invalid" rule below, because "invalid api key"
  // matches both and only one of those readings is useful.
  if (
    /insufficient credit|out of credit|quota exceeded|balance|payment required|invalid api key|unauthorized|forbidden|authentication/.test(m)
  ) {
    return { kind: "infrastructure", scope: "provider" };
  }

  // The host itself is unreachable — nothing on it can work.
  if (/enotfound|econnrefused|dns|getaddrinfo/.test(m)) {
    return { kind: "infrastructure", scope: "provider" };
  }

  // Our own fault: a request the provider was right to reject.
  if (/invalid|unsupported|must be|required|malformed|too large|not a valid/.test(m)) {
    return { kind: "request", scope: "route" };
  }

  if (typeof status === "number") {
    if (status === 401 || status === 403) return { kind: "infrastructure", scope: "provider" };
    if (status === 402) return { kind: "infrastructure", scope: "provider" };
    if (status === 429) return { kind: "infrastructure", scope: "provider" };
    if (status >= 500) return { kind: "infrastructure", scope: "route" };
    if (status >= 400) return { kind: "request", scope: "route" };
  }

  if (/timeout|timed out|econnreset|network|socket|fetch failed|aborted/.test(m)) {
    return { kind: "infrastructure", scope: "route" };
  }

  // Unknown: infrastructure, route-scoped. The threshold and the probe make a
  // false positive cheap (one fallback generation), while a false negative
  // keeps routing buyers into a hole.
  return { kind: "infrastructure", scope: "route" };
}

export interface HealthRow {
  model_provider_id: string;
  provider_id: string;
  status: "healthy" | "down";
  consecutive_failures: number;
  last_probe_at: string | null;
  last_quoted_micro: number | null;
}

/**
 * Whether the breaker allows this route now, given its row and the clock.
 * Pure, so the state machine can be tested without a database or a network —
 * this is the part that decides where a customer's money goes.
 */
export function breakerVerdict(
  row: Pick<HealthRow, "status" | "last_probe_at"> | null,
  now: number,
): "use" | "skip" | "probe" {
  if (!row || row.status === "healthy") return "use";
  const last = row.last_probe_at ? Date.parse(row.last_probe_at) : 0;
  if (now - last >= PROBE_COOLDOWN_MS) return "probe";
  return "skip";
}

/** Whether this failure opens the breaker now. */
export function shouldOpen(c: Classification, consecutiveFailures: number): boolean {
  if (c.kind !== "infrastructure") return false;
  // Account-wide failures are unambiguous — no second opinion needed.
  if (c.scope === "provider") return true;
  return consecutiveFailures + 1 >= FAILURE_THRESHOLD;
}

/**
 * Liveness probes, per provider key. A probe must be FREE and must not
 * generate anything — an x402 quote with no payment header satisfies both,
 * because the gateway cannot run work it has not been paid for.
 */
export type Probe = (providerModel: string) => Promise<{ alive: boolean; quotedMicro?: number }>;

/**
 * AceData serves the nano-banana family and the OpenAI-shaped family on
 * different paths, and a quote is only meaningful on the path the route
 * actually uses — asking the wrong one would report a working model as broken.
 */
function acedataPath(providerModel: string): string {
  return providerModel.startsWith("nano-banana")
    ? "/nano-banana/images"
    : "/openai/images/generations";
}

const PROBES: Record<string, Probe> = {
  acedata: async (providerModel) => {
    const res = await fetch(`https://x402.acedata.cloud${acedataPath(providerModel)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No PAYMENT-SIGNATURE header: the gateway answers 402 with its price
      // and runs nothing. Deliberately no prompt either, so there is nothing
      // to generate even if that assumption were ever wrong.
      body: JSON.stringify({ model: providerModel }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status !== 402) return { alive: false };
    const body = (await res.json()) as {
      accepts?: { network?: string; maxAmountRequired?: string }[];
    };
    const sol = body.accepts?.find((a) => String(a.network).startsWith("solana"));
    return sol ? { alive: true, quotedMicro: Number(sol.maxAmountRequired) } : { alive: false };
  },
};

export function probeFor(providerKey: string): Probe | null {
  return PROBES[providerKey] ?? null;
}

/** Health rows for the given routes, keyed by model_provider id. */
export async function loadHealth(
  supabase: SupabaseClient,
  modelProviderIds: string[],
): Promise<Map<string, HealthRow>> {
  if (modelProviderIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("model_provider_health")
    .select("model_provider_id, provider_id, status, consecutive_failures, last_probe_at, last_quoted_micro")
    .in("model_provider_id", modelProviderIds);
  if (error) {
    // Health is an optimisation, never a gate: if we cannot read it, every
    // route is assumed usable rather than none.
    console.warn("[provider-health] could not read:", error.message);
    return new Map();
  }
  return new Map((data ?? []).map((r) => [r.model_provider_id, r as HealthRow]));
}

export async function reportSuccess(
  supabase: SupabaseClient,
  modelProviderId: string,
  providerId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("model_provider_health").upsert(
    {
      model_provider_id: modelProviderId,
      provider_id: providerId,
      status: "healthy",
      consecutive_failures: 0,
      opened_at: null,
      last_success_at: now,
      last_error: null,
      updated_at: now,
    },
    { onConflict: "model_provider_id" },
  );
  if (error) console.warn("[provider-health] success not recorded:", error.message);
}

/**
 * Record a failure and open the breaker if this was the last straw.
 * Returns what was opened, so the caller can log it meaningfully.
 */
export async function reportFailure(
  supabase: SupabaseClient,
  modelProviderId: string,
  providerId: string,
  message: string,
  status?: number,
): Promise<{ opened: "none" | "route" | "provider" }> {
  const c = classifyFailure(message, status);
  if (c.kind !== "infrastructure") return { opened: "none" };

  const now = new Date().toISOString();
  const error = message.slice(0, 300);

  // Account-wide: every route of this provider is affected, and waiting to
  // rediscover that per model costs a customer a generation each time.
  if (c.scope === "provider") {
    await supabase
      .from("model_provider_health")
      .update({ status: "down", opened_at: now, last_failure_at: now, last_error: error, updated_at: now })
      .eq("provider_id", providerId);
    // The row for THIS route may not exist yet — the update above only
    // touches rows that do.
    await supabase.from("model_provider_health").upsert(
      {
        model_provider_id: modelProviderId,
        provider_id: providerId,
        status: "down",
        consecutive_failures: FAILURE_THRESHOLD,
        opened_at: now,
        last_failure_at: now,
        last_error: error,
        updated_at: now,
      },
      { onConflict: "model_provider_id" },
    );
    console.error(`[provider-health] breaker OPEN for ALL routes of provider ${providerId}: ${error.slice(0, 160)}`);
    return { opened: "provider" };
  }

  const { data } = await supabase
    .from("model_provider_health")
    .select("consecutive_failures")
    .eq("model_provider_id", modelProviderId)
    .maybeSingle();

  const failures = (data?.consecutive_failures ?? 0) + 1;
  const open = shouldOpen(c, failures - 1);

  await supabase.from("model_provider_health").upsert(
    {
      model_provider_id: modelProviderId,
      provider_id: providerId,
      status: open ? "down" : "healthy",
      consecutive_failures: failures,
      ...(open ? { opened_at: now } : {}),
      last_failure_at: now,
      // Truncated: a provider's error body is not a place to store megabytes,
      // and it can echo back things we sent it.
      last_error: error,
      updated_at: now,
    },
    { onConflict: "model_provider_id" },
  );

  if (open) console.error(`[provider-health] breaker OPEN for route ${modelProviderId}: ${error.slice(0, 160)}`);
  return { opened: open ? "route" : "none" };
}

/** Run the probe and write the outcome. Returns whether the route is alive. */
export async function runProbe(
  supabase: SupabaseClient,
  modelProviderId: string,
  providerId: string,
  providerKey: string,
  providerModel: string,
): Promise<boolean> {
  const probe = probeFor(providerKey);
  const now = new Date().toISOString();

  // No probe available: half-open — let one real request decide.
  if (!probe) {
    await supabase
      .from("model_provider_health")
      .upsert(
        { model_provider_id: modelProviderId, provider_id: providerId, last_probe_at: now, updated_at: now },
        { onConflict: "model_provider_id" },
      );
    return true;
  }

  let alive = false;
  let quotedMicro: number | undefined;
  try {
    const result = await probe(providerModel);
    alive = result.alive;
    quotedMicro = result.quotedMicro;
  } catch {
    alive = false;
  }

  await supabase.from("model_provider_health").upsert(
    {
      model_provider_id: modelProviderId,
      provider_id: providerId,
      status: alive ? "healthy" : "down",
      ...(alive ? { consecutive_failures: 0, opened_at: null, last_success_at: now } : {}),
      last_probe_at: now,
      ...(quotedMicro !== undefined ? { last_quoted_micro: quotedMicro } : {}),
      updated_at: now,
    },
    { onConflict: "model_provider_id" },
  );

  if (alive) console.warn(`[provider-health] breaker CLOSED for ${providerKey}/${providerModel} — back on the cheap route`);
  return alive;
}
