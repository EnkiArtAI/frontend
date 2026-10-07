import { describe, expect, it, vi, afterEach } from "vitest";
import {
  PROVIDERS_WITH_IMAGE_INPUT,
  REFERENCE_IMAGE_LIMITS,
  canCarryReferenceImages,
  referenceImageCount,
  referenceImageLimit,
  supportsReferenceImages,
} from "@/lib/generation/provider-capabilities";
import { eligibleRoutes, type RouteLink } from "@/lib/generation/routing";

/*
 * A buyer attaches reference images, pays, and receives a picture generated
 * without them. No error, no warning, and an output that looks like a perfectly
 * good answer to the prompt — so neither side can tell it happened.
 *
 * That was live on 2026-08-12: both paid models routed to WaveSpeed at priority
 * 10, and neither the WaveSpeed nor the OpenAI adapter read `referenceImages`.
 *
 * The tests that matter here ask ONE question of each adapter: do the images
 * actually leave the building? Everything else — error wording, retry flags —
 * is secondary to the outgoing request carrying what the buyer paid for.
 */

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const REFS = [PNG, JPG];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Captures what the adapter tried to send, and answers with a failure. */
function captureFetch() {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    // A 500 ends the call immediately; we only care about the request.
    return new Response("{}", { status: 500 });
  });
  vi.stubGlobal("fetch", spy);
  return { seen, spy };
}

/** A fetch that fails the test if anything reaches it. */
function forbiddenFetch() {
  const spy = vi.fn(() => {
    throw new Error("the adapter contacted the provider — that request costs money");
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

// Every real caller passes the routed model (ENG-01: no adapter guesses one),
// so these reference-image tests send it too unless a test names its own.
async function waveSpeed() {
  vi.stubEnv("WAVESPEED_API_KEY", "test-key-not-a-real-one");
  const generate = (await import("@/backend/services/wavespeed-image-generation"))
    .generateImagesWithWaveSpeed;
  return (r: Parameters<typeof generate>[0]) =>
    generate({ modelVersion: "google/nano-banana-pro/text-to-image", ...r });
}

async function openAI() {
  vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-real-one");
  const generate = (await import("@/backend/services/openai-image-generation")).generateImagesWithOpenAI;
  return (r: Parameters<typeof generate>[0]) => generate({ modelVersion: "gpt-image-2", ...r });
}

describe("WaveSpeed actually sends the reference images", () => {
  it("switches to the edit endpoint and puts every image in the body", async () => {
    const { seen } = captureFetch();
    const generate = await waveSpeed();

    await generate({
      prompt: "a teapot",
      referenceImages: REFS,
      modelVersion: "google/nano-banana-pro/text-to-image",
    });

    // The model id IS the URL path on WaveSpeed, so the endpoint switch and
    // the id switch are the same act.
    expect(seen[0].url).toContain("/google/nano-banana-pro/edit");
    expect(seen[0].url).not.toContain("text-to-image");

    const body = JSON.parse(String(seen[0].init?.body));
    expect(body.images).toEqual(REFS);
    expect(body.prompt).toBe("a teapot");
  });

  it("stays on text-to-image, with no images key, when none are attached", async () => {
    const { seen } = captureFetch();
    const generate = await waveSpeed();

    await generate({ prompt: "a teapot", modelVersion: "google/nano-banana-pro/text-to-image" });

    expect(seen[0].url).toContain("/text-to-image");
    expect(JSON.parse(String(seen[0].init?.body))).not.toHaveProperty("images");
  });

  it("leaves an id that already names an edit endpoint alone", async () => {
    const { seen } = captureFetch();
    const generate = await waveSpeed();

    await generate({
      prompt: "a teapot",
      referenceImages: [PNG],
      modelVersion: "google/nano-banana-pro/edit",
    });

    expect(seen[0].url).toContain("/google/nano-banana-pro/edit");
    expect(seen[0].url).not.toContain("/edit/edit");
  });

  it("refuses over its documented ceiling rather than sending a subset", async () => {
    // Sending 14 of 15 would be the silent-loss bug again with a smaller loss.
    const spy = forbiddenFetch();
    const generate = await waveSpeed();

    const result = await generate({
      prompt: "a teapot",
      referenceImages: Array.from({ length: 15 }, () => PNG),
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/at most 14/);
  });
});

describe("OpenAI actually sends the reference images", () => {
  it("posts multipart to the edits endpoint with one part per image", async () => {
    const { seen } = captureFetch();
    const generate = await openAI();

    await generate({ prompt: "a teapot", referenceImages: REFS });

    expect(seen[0].url).toBe("https://api.openai.com/v1/images/edits");
    const form = seen[0].init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.getAll("image[]")).toHaveLength(2);
    expect(form.get("prompt")).toBe("a teapot");
  });

  it("decodes the data URI to real bytes, keeping the media type", async () => {
    // A part sent as the data-URI STRING would be accepted by FormData and
    // rejected by OpenAI — after the buyer paid. The bytes have to be decoded.
    const { seen } = captureFetch();
    const generate = await openAI();

    await generate({ prompt: "a teapot", referenceImages: REFS });

    const parts = (seen[0].init?.body as FormData).getAll("image[]") as File[];
    expect(parts[0].type).toBe("image/png");
    expect(parts[1].type).toBe("image/jpeg");
    expect(parts[0].size).toBeGreaterThan(0);
    // The base64 above decodes to fewer bytes than its own text length.
    expect(parts[0].size).toBeLessThan(PNG.length);
  });

  it("never sets Content-Type by hand on the multipart branch", async () => {
    // fetch has to add the boundary. A hand-written multipart Content-Type
    // produces a body the server cannot parse, and the error names the field
    // rather than the cause.
    const { seen } = captureFetch();
    const generate = await openAI();

    await generate({ prompt: "a teapot", referenceImages: [PNG] });

    const headers = (seen[0].init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("content-type");
  });

  it("stays on the JSON generations endpoint when none are attached", async () => {
    const { seen } = captureFetch();
    const generate = await openAI();

    await generate({ prompt: "a teapot" });

    expect(seen[0].url).toBe("https://api.openai.com/v1/images/generations");
    expect(typeof seen[0].init?.body).toBe("string");
  });

  it("refuses over its documented ceiling", async () => {
    const spy = forbiddenFetch();
    const generate = await openAI();

    const result = await generate({
      prompt: "a teapot",
      referenceImages: Array.from({ length: 17 }, () => PNG),
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at most 16/);
  });

  it("refuses when a reference cannot be decoded, naming which one", async () => {
    // Not "use the ones that worked". Four of five delivered and five charged
    // is the original bug wearing a smaller coat.
    const spy = forbiddenFetch();
    const generate = await openAI();

    const result = await generate({
      prompt: "a teapot",
      referenceImages: [PNG, "data:image/png;base64,"],
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/Reference image 2/);
  });
});

const POLL_INTERVAL_MS = 2000; // mirrors backend/services/wavespeed-image-generation.ts

describe("WaveSpeed polling stops on every terminal status, not just failure", () => {
  /* WaveSpeed documents six statuses and only created/processing mean "keep
     waiting". Treating cancelled and timeout as non-terminal left the loop
     spinning for its full 240s before reporting a timeout of our own — four
     minutes of the buyer's wait to be told the wrong reason for a job that
     had already ended. */
  /* Fake timers, so the adapter's 2s poll interval costs nothing.
     These two cases used to sleep for real — 2011ms each, measured — which is
     four seconds of every suite run spent waiting, and four seconds during
     which every other vitest worker competes for the machine. The property
     under test is "does it stop at a terminal status", never "how long does a
     sleep take". */
  async function pollOnce(terminalStatus: string) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("/predictions/")) {
        return new Response(JSON.stringify({ data: { status: terminalStatus } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { id: "p1" } }), { status: 200 });
    });
    const generate = await waveSpeed();
    vi.useFakeTimers();
    const started = Date.now();
    // Started, not awaited: the adapter is sitting on setTimeout, so the
    // timers have to move before the promise can settle.
    const pending = generate({ prompt: "a teapot" });
    // Well past one interval and nowhere near MAX_POLL_MS (240s) — if the
    // status were treated as non-terminal this would NOT be enough.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    const result = await pending;
    const elapsed = Date.now() - started;
    vi.useRealTimers();
    return { result, elapsed };
  }

  it("returns as soon as the provider says cancelled", async () => {
    const { result, elapsed } = await pollOnce("cancelled");
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    // The loop's own ceiling is 240s; anything near it means it kept spinning.
    expect(elapsed).toBeLessThan(30_000);
  });

  it("returns as soon as the provider says timeout", async () => {
    const { result, elapsed } = await pollOnce("timeout");
    expect(result.success).toBe(false);
    expect(elapsed).toBeLessThan(30_000);
  });
});

describe("routing picks a host by how many images it can take", () => {
  // The live shape for Nano Banana Pro: cheap host first, capable host second.
  const LINKS: RouteLink[] = [
    {
      id: "ws",
      role: "normal",
      priority: 10,
      provider_model: "google/nano-banana-pro/text-to-image",
      provider_id: "p-ws",
      providers: { id: "p-ws", key: "wavespeed", active: true },
    },
    {
      id: "gem",
      role: "normal",
      priority: 20,
      provider_model: "gemini-3-pro-image-preview",
      provider_id: "p-gem",
      providers: { id: "p-gem", key: "gemini", active: true },
    },
  ];
  const keys = (refs?: number) =>
    eligibleRoutes(LINKS, {}, "normal", "public", refs === undefined ? {} : { referenceImages: refs })
      .map((r) => r.providerKey);

  it("keeps the cheap host when it can serve the request", () => {
    expect(keys()).toEqual(["wavespeed", "gemini"]);
    expect(keys(1)).toEqual(["wavespeed", "gemini"]);
    expect(keys(14)).toEqual(["wavespeed", "gemini"]);
  });

  it("drops the cheap host once the count passes ITS ceiling, not ours", () => {
    // 15 is inside our own 18-image allowance and outside WaveSpeed's 14. A
    // yes/no capability flag could not see this, and the request would have
    // been rejected by the provider after the buyer had paid.
    expect(keys(15)).toEqual(["gemini"]);
    expect(keys(18)).toEqual(["gemini"]);
  });

  it("returns nothing rather than a host that would fail or discard them", () => {
    const onlyWaveSpeed = [LINKS[0]];
    expect(
      eligibleRoutes(onlyWaveSpeed, {}, "normal", "public", { referenceImages: 15 }),
    ).toEqual([]);
  });
});

describe("the fallback route gets the same capability test as the rest", () => {
  /* chooseRoute drops back to routeFor() whenever the ordered list cannot be
     built — no supabase, no links, nothing eligible. That fallback used to be
     handed back unexamined, which is how a request with references still ended
     up on a host that discards them. */
  const model = {
    id: null,
    name: "Nano Banana Pro",
    normal: { provider: "wavespeed" as const, providerModel: "google/nano-banana-pro/text-to-image" },
    boost: { provider: "gemini" as const, providerModel: "gemini-3-pro-image-preview" },
    allowedRatios: ["1:1"],
    maxRefs: 18,
    supportsQuality: false,
    supportsResolution: true,
    links: [],
  };

  it("hands back the cheap fallback for a count it can serve", async () => {
    const { chooseRoute } = await import("@/lib/generation/models");
    expect((await chooseRoute(null, model as never, { referenceImages: 3 }))?.provider).toBe(
      "wavespeed",
    );
  });

  it("hands back nothing when the only fallback cannot take that many", async () => {
    const { chooseRoute } = await import("@/lib/generation/models");
    expect(await chooseRoute(null, model as never, { referenceImages: 15 })).toBeNull();
  });

  it("accepts a fallback that can", async () => {
    const { chooseRoute } = await import("@/lib/generation/models");
    const route = await chooseRoute(null, model as never, { boost: true, referenceImages: 15 });
    expect(route?.provider).toBe("gemini");
  });
});

describe("the capability list is a promise, not a wish list", () => {
  it("names exactly the providers whose adapter demonstrably sends the images", () => {
    /* Deliberately exact. Adding a provider here without wiring its adapter
       re-creates the original bug in one line, so the set cannot be widened
       without this test being edited — which is the moment to ask whether a
       test proving the images actually reach that provider exists yet. */
    expect([...PROVIDERS_WITH_IMAGE_INPUT].sort()).toEqual(["gemini", "openai", "wavespeed"]);
  });

  it("carries each host's documented ceiling, not a shared guess", () => {
    expect(REFERENCE_IMAGE_LIMITS.get("wavespeed")).toBe(14);
    expect(REFERENCE_IMAGE_LIMITS.get("openai")).toBe(16);
    expect(REFERENCE_IMAGE_LIMITS.get("gemini")).toBe(18);
  });

  it("does not claim support for a host that takes none", () => {
    expect(supportsReferenceImages("pollinations")).toBe(false);
    expect(referenceImageLimit("pollinations")).toBe(0);
    expect(canCarryReferenceImages("pollinations", 1)).toBe(false);
    // ...but a request with nothing attached is fine anywhere.
    expect(canCarryReferenceImages("pollinations", 0)).toBe(true);
  });

  it("matches the provider key regardless of case, and never on nothing", () => {
    expect(supportsReferenceImages("GEMINI")).toBe(true);
    expect(supportsReferenceImages(null)).toBe(false);
    expect(supportsReferenceImages(undefined)).toBe(false);
    expect(supportsReferenceImages("")).toBe(false);
  });

  it("counts only images that are really there", () => {
    // A blank string is not an attachment; counting it would refuse or reroute
    // a request that has nothing wrong with it.
    expect(referenceImageCount([PNG, JPG])).toBe(2);
    expect(referenceImageCount([PNG, "", "  "])).toBe(1);
    expect(referenceImageCount([])).toBe(0);
    expect(referenceImageCount(null)).toBe(0);
    expect(referenceImageCount(undefined)).toBe(0);
  });
});
