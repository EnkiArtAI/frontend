import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  breakerVerdict,
  shouldOpen,
  probeFor,
  FAILURE_THRESHOLD,
  PROBE_COOLDOWN_MS,
} from "@/lib/generation/provider-health";

/**
 * The breaker decides where a paying customer's generation goes. Both ways of
 * being wrong cost real money: opening on the wrong signal sends everyone to
 * the dearer route, and not opening keeps feeding buyers into a dead host.
 */

describe("what must never open the breaker", () => {
  it("does not blame the provider for a refused prompt", () => {
    for (const msg of [
      "Your request was rejected as a result of our safety system",
      "content_policy_violation",
      "The prompt was blocked by the moderation filter",
      "This request produces prohibited content",
    ]) {
      expect(classifyFailure(msg).kind, msg).toBe("content");
      expect(shouldOpen(classifyFailure(msg), 99), msg).toBe(false);
    }
  });

  it("does not blame the provider for a request we built wrong", () => {
    for (const msg of [
      "size must be a multiple of 16",
      "Invalid value for parameter 'quality'",
      "aspect_ratio is not a valid ratio",
      "image too large",
    ]) {
      expect(classifyFailure(msg).kind, msg).toBe("request");
      expect(shouldOpen(classifyFailure(msg), 99), msg).toBe(false);
    }
  });

  it("does not blame the provider for a key this deployment does not have (ENV-01)", () => {
    // The breaker state lives in a database other deployments share: a
    // developer environment without the key must not take production down.
    for (const msg of ["OPENAI_API_KEY is not set", "WAVESPEED_API_KEY is not set", "GEMINI_API_KEY is not set"]) {
      expect(classifyFailure(msg).kind, msg).toBe("config");
      expect(shouldOpen(classifyFailure(msg), 99), msg).toBe(false);
    }
    // ...while a provider that refuses our key still counts.
    expect(classifyFailure("invalid api key").kind).toBe("infrastructure");
    expect(classifyFailure("the setting is not settled").kind).not.toBe("config");
  });

  it("keeps counting content refusals harmless however many arrive", () => {
    // A user hammering a banned prompt must not take the model offline.
    expect(shouldOpen(classifyFailure("safety system rejected"), 1000)).toBe(false);
  });
});

describe("failures that are about the account, not the model", () => {
  it("treats money and credentials as provider-wide and immediate", () => {
    for (const msg of [
      "WaveSpeed account is out of credits",
      "Insufficient credits",
      "quota exceeded for this month",
      "invalid api key",
      "Unauthorized",
      "authentication failed",
      "getaddrinfo ENOTFOUND api.example.com",
    ]) {
      const c = classifyFailure(msg);
      expect(c.kind, msg).toBe("infrastructure");
      expect(c.scope, msg).toBe("provider");
      // No threshold: a revoked key does not recover on the second attempt.
      expect(shouldOpen(c, 0), msg).toBe(true);
    }
  });

  it("reads 'invalid api key' as a credential, not as a bad parameter", () => {
    // Both the credential rule and the generic "invalid" rule match this
    // string; only one of the two readings is useful, and order decides it.
    const c = classifyFailure("invalid api key provided");
    expect(c.kind).toBe("infrastructure");
    expect(c.scope).toBe("provider");
  });

  it("classifies by status code when the message says nothing", () => {
    expect(classifyFailure("", 401).scope).toBe("provider");
    expect(classifyFailure("", 402).scope).toBe("provider");
    expect(classifyFailure("", 429).scope).toBe("provider");
    expect(classifyFailure("", 503)).toEqual({ kind: "infrastructure", scope: "route" });
    expect(classifyFailure("", 400).kind).toBe("request");
  });
});

describe("failures that are about this route only", () => {
  it("needs three strikes before giving up on a model", () => {
    const c = classifyFailure("upstream timed out");
    expect(c).toEqual({ kind: "infrastructure", scope: "route" });
    // Literal counts, not FAILURE_THRESHOLD arithmetic: a loop bounded by the
    // constant passes for any value of it, including 1, which would send
    // everyone to the dearer route on a single hiccup.
    expect(shouldOpen(c, 0)).toBe(false);
    expect(shouldOpen(c, 1)).toBe(false);
    expect(shouldOpen(c, 2)).toBe(true);
    expect(FAILURE_THRESHOLD).toBe(3);
  });

  it("fails closed on an error nobody anticipated", () => {
    // Unknown text must not read as healthy — one fallback generation is
    // cheaper than a queue of customers hitting a hole.
    const c = classifyFailure("¡qué pasa!");
    expect(c.kind).toBe("infrastructure");
    expect(c.scope).toBe("route");
  });
});

describe("when the breaker lets traffic through", () => {
  const now = 1_800_000_000_000;

  it("uses a route it has never heard of", () => {
    expect(breakerVerdict(null, now)).toBe("use");
  });

  it("uses a healthy route without probing", () => {
    expect(breakerVerdict({ status: "healthy", last_probe_at: null }, now)).toBe("use");
  });

  it("skips a route that was just probed and found dead", () => {
    const justNow = new Date(now - 1000).toISOString();
    expect(breakerVerdict({ status: "down", last_probe_at: justNow }, now)).toBe("skip");
  });

  it("re-probes once the cooldown has passed", () => {
    const old = new Date(now - PROBE_COOLDOWN_MS - 1).toISOString();
    expect(breakerVerdict({ status: "down", last_probe_at: old }, now)).toBe("probe");
  });

  it("probes a route marked down that has never been probed", () => {
    expect(breakerVerdict({ status: "down", last_probe_at: null }, now)).toBe("probe");
  });

  it("waits the FULL cooldown, so a dead host is not hammered", () => {
    const almost = new Date(now - PROBE_COOLDOWN_MS + 1).toISOString();
    expect(breakerVerdict({ status: "down", last_probe_at: almost }, now)).toBe("skip");
  });
});

describe("the liveness probe", () => {
  it("exists for acedata and not for providers without a free check", () => {
    expect(probeFor("acedata")).toBeTypeOf("function");
    expect(probeFor("wavespeed")).toBeNull();
    expect(probeFor("nonsense")).toBeNull();
  });

  it("asks the path the route actually uses, and never sends a prompt", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return {
        status: 402,
        json: async () => ({
          accepts: [{ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", maxAmountRequired: "49054" }],
        }),
      };
    }) as unknown as typeof fetch;

    try {
      const probe = probeFor("acedata")!;
      const nano = await probe("nano-banana-pro:official");
      const gpt = await probe("gpt-image-2");

      expect(calls[0].url).toContain("/nano-banana/images");
      expect(calls[1].url).toContain("/openai/images/generations");
      // A probe that carried a prompt could generate — and cost money.
      expect(calls.every((c) => !("prompt" in (c.body as object)))).toBe(true);
      expect(nano).toEqual({ alive: true, quotedMicro: 49054 });
      expect(gpt.alive).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports dead when the gateway does not answer with a quote", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({ status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    try {
      expect(await probeFor("acedata")!("gpt-image-2")).toEqual({ alive: false });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("insists on 402 — a 200 carrying a quote-shaped body is not liveness", async () => {
    // The body alone must not decide it. A cache, a proxy or an error page can
    // return 200 with anything in it; only 402 means "I am here and this is
    // the price".
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 200,
      json: async () => ({
        accepts: [{ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", maxAmountRequired: "49054" }],
      }),
    })) as unknown as typeof fetch;
    try {
      expect(await probeFor("acedata")!("gpt-image-2")).toEqual({ alive: false });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports dead when the quote carries no Solana leg we can pay", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 402,
      json: async () => ({ accepts: [{ network: "eip155:8453", maxAmountRequired: "49054" }] }),
    })) as unknown as typeof fetch;
    try {
      expect(await probeFor("acedata")!("gpt-image-2")).toEqual({ alive: false });
    } finally {
      globalThis.fetch = original;
    }
  });
});
