import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { GenerationQuote } from "@/lib/generation-checkout";
import type { PromptVariable } from "../segments";
import { againStep, jobSaid, makeSetup, quoteOf, toRequest, type Composer, type JobPrice } from "../setups";

const variable = (name: string, over: Partial<PromptVariable> = {}): PromptVariable => ({
  id: name, name, label: null, description: "", type: "text", defaultValue: null,
  required: false, position: 0, min: null, max: null, options: null, ...over,
});
const model = (over: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  id: "m-nbp", name: "Nano Banana Pro", price: 0.1, mediaType: "image", supportsQuality: false,
  maxResolution: "4K", ratios: ["1:1", "4:5"], boostTiers: ["2K", "4K"], boostAvailable: true, free: false, ...over,
});

const subject = variable("subject", { label: "Subject", position: 1 });
const rain = variable("rain", { type: "checkbox", label: "Rain", description: "in heavy rain", position: 2 });

const composer = (over: Partial<Composer> = {}): Composer => ({
  promptId: "p1", title: "Harbour", publicText: "[Subject] [rain] at dusk", edited: null,
  variables: [subject, rain], values: { subject: "a fox", rain: "true" },
  model: model(), resolution: "2K", aspectRatio: "4:5", quality: "high", boost: false, refs: [], ...over,
});

describe("makeSetup", () => {
  it("is null while no generator is chosen", () => {
    expect(makeSetup(composer({ model: undefined }))).toBeNull();
  });

  it("holds a free prompt's job: the filled text, and the values by stored name for the server", () => {
    const s = makeSetup(composer())!;
    expect(s).toMatchObject({
      promptId: "p1", resolution: "2K", aspectRatio: "4:5", boost: false,
      prompt: "a fox in heavy rain at dusk",
      variableValues: { subject: "a fox", rain: "in heavy rain" },
      values: { subject: "a fox", rain: "true" }, edited: null, refs: [],
    });
    expect(s.rows).toEqual([{ name: "Subject", value: "a fox" }, { name: "Rain", value: "in heavy rain", checked: true }]);
  });

  it("sends the buyer's own wording when there is one, and keeps it for Regenerate", () => {
    const s = makeSetup(composer({ edited: "[Subject] under [moon]", values: { subject: "a fox", rain: "true", moon: "a full moon" } }))!;
    expect(s.prompt).toBe("a fox under a full moon");
    expect(s.edited).toBe("[Subject] under [moon]");
    expect(s.rows).toEqual([{ name: "Subject", value: "a fox" }, { name: "moon", value: "a full moon" }]);
  });

  it("sends a premium prompt's stand-in, which the server replaces with the artist's text", () => {
    const s = makeSetup(composer({ publicText: null }))!;
    expect(s.prompt).toBe("Harbour, Subject: a fox, Rain: in heavy rain");
    expect(s.variableValues).toEqual({ subject: "a fox", rain: "in heavy rain" });
    expect(s.rows.map((r) => r.name)).toEqual(["Subject", "Rain"]);
  });

  it("holds the blank composer's job without a prompt id or values", () => {
    const s = makeSetup(composer({ promptId: undefined, title: undefined, publicText: "", edited: "a [beast] on a hill", variables: [], values: { beast: "wolf" } }))!;
    expect(s.prompt).toBe("a wolf on a hill");
    expect("promptId" in s).toBe(false);
    expect("variableValues" in s).toBe(false);
    expect(s.rows).toEqual([{ name: "beast", value: "wolf" }]);
  });

  it("keeps quality only where the model has the lever, and Boost only where a faster host exists at that size", () => {
    expect("quality" in makeSetup(composer())!).toBe(false);
    expect(makeSetup(composer({ model: model({ supportsQuality: true }) }))!.quality).toBe("high");
    expect(makeSetup(composer({ boost: true }))!.boost).toBe(true);
    expect(makeSetup(composer({ boost: true, resolution: "1K" }))!.boost).toBe(false);
  });

  it("is a snapshot: later edits to the composer do not change the job", () => {
    const c = composer({ refs: ["data:image/webp;base64,AA"] });
    const s = makeSetup(c)!;
    c.values.subject = "a wolf";
    c.refs.push("data:image/webp;base64,BB");
    expect(s.values.subject).toBe("a fox");
    expect(s.refs).toEqual(["data:image/webp;base64,AA"]);
  });
});

describe("toRequest", () => {
  it("sends a prompt's job with its prompt id and values, and the references it holds, each named in the text", () => {
    const s = makeSetup(composer({ boost: true, refs: ["data:a", "data:b"] }))!;
    expect(toRequest(s)).toEqual({
      // A text that names no reference gets them after it (Kev, 2026-10-13); one that names some gets the rest after its last.
      model: s.model, resolution: "2K", quality: undefined, boost: true, prompt: "a fox in heavy rain at dusk Reference image 1 Reference image 2",
      promptId: "p1", variableValues: { subject: "a fox", rain: "in heavy rain" }, aspectRatio: "4:5",
      referenceImages: ["data:a", "data:b"],
    });
    expect(makeSetup(composer({ edited: "[subject] like Reference image 1, [rain]", refs: ["data:a", "data:b", "data:c"] }))!.prompt)
      .toBe("a fox like Reference image 1 Reference image 2 Reference image 3, in heavy rain");
    // The count travels from the composer's images, every time.
    expect(readSource(join(__dirname, "..", "setups.ts"))).toContain("prompt: buildGenerationPrompt({ title: c.title, text, variables: c.variables, values: c.values, refs: c.refs.length }),");
  });

  it("sends the blank composer's job with neither, and no empty reference list", () => {
    const req = toRequest(makeSetup(composer({ promptId: undefined, publicText: "", edited: "a hill", variables: [], values: {} }))!);
    expect(req.prompt).toBe("a hill");
    expect("promptId" in req).toBe(false);
    expect("variableValues" in req).toBe(false);
    expect("referenceImages" in req).toBe(false);
  });
});

describe("quoteOf", () => {
  it("prices the job's own settings and counts its references", () => {
    const s = makeSetup(composer({ boost: true, refs: ["data:a", "data:b"], model: model({ supportsQuality: true }) }))!;
    expect(quoteOf(s)).toEqual({ promptId: "p1", entry: s.model, resolution: "2K", quality: "high", boost: true, referenceImageCount: 2 });
  });
});

describe("againStep (Regenerate, Retry)", () => {
  const quote = (usd: string): GenerationQuote => ({
    totalMicro: Math.round(Number(usd) * 1_000_000), totalUsd: usd, networkFeeUsd: "0", artistUsd: "0", expiresAt: "", appliedRule: null,
  });
  const priced = (q: GenerationQuote | null, over: Partial<JobPrice> = {}): JobPrice => ({ quote: q, pending: false, unavailable: false, ...over });
  const wallet = { payer: "So1anaPayer", ready: true, balance: 1 };
  const paid = makeSetup(composer({ resolution: "4K" }))!;

  it("runs a job whose own price the balance covers", () => {
    expect(againStep(paid, priced(quote("0.30")), wallet)).toEqual({});
  });

  it("asks the low-balance question first when the job's own price is above the balance", () => {
    const q = quote("0.30");
    expect(againStep(paid, priced(q), { ...wallet, balance: 0.29 })).toEqual({ funds: q });
    // Exactly enough is enough (integer micro-USDC, not a float sum).
    expect(againStep(paid, priced(q), { ...wallet, balance: 0.3 })).toEqual({});
  });

  it("never asks it where the balance cannot be read: still loading, no payer, or an EVM address", () => {
    const q = quote("0.30");
    expect(againStep(paid, priced(q), { ...wallet, balance: 0, ready: false })).toEqual({});
    expect(againStep(paid, priced(q), { ...wallet, balance: 0, payer: null })).toEqual({});
    expect(againStep(paid, priced(q), { ...wallet, balance: 0, payer: "0xabc" })).toEqual({});
  });

  it("does not run a paid job without its price, and says why", () => {
    expect(againStep(paid, priced(null, { pending: true }), wallet)).toEqual({ why: "The price is on its way" });
    expect(againStep(paid, priced(null), wallet)).toEqual({ why: "Price unavailable right now" });
  });

  it("does not run it once the prompt is gone", () => {
    expect(againStep(paid, priced(null, { unavailable: true }), wallet)).toEqual({ why: "This prompt is no longer available" });
  });

  it("runs a job on the free host, which has no price and charges nothing", () => {
    const free = makeSetup(composer({ model: model({ free: true }) }))!;
    expect(againStep(free, priced(null), { ...wallet, balance: 0 })).toEqual({});
  });
});

describe("jobSaid", () => {
  it("says a render that failed before anything was signed was not charged", () => {
    expect(jobSaid({ status: "failed", error: { message: "Render failed · not charged · x", charged: "no" } })).toBe("failed, not charged");
  });

  it("never says \"not charged\" when the charge is unknown, or not said at all", () => {
    expect(jobSaid({ status: "failed", error: { message: "Connection lost", charged: "unknown" } })).toBe("failed, charged only if it reached your gallery");
    expect(jobSaid({ status: "failed" })).toBe("failed, charged only if it reached your gallery");
  });

  it("says rendering once the request went out, in line (with its X) before, and ready as it is", () => {
    expect(jobSaid({ status: "rendering", sent: true })).toBe("rendering");
    expect(jobSaid({ status: "rendering", sent: false })).toBe("in line, cancel with its X");
    expect(jobSaid({ status: "rendering" })).toBe("in line, cancel with its X");
    expect(jobSaid({ status: "ready" })).toBe("ready");
    expect(jobSaid({ status: "ready", sent: true })).toBe("ready");
  });
});
