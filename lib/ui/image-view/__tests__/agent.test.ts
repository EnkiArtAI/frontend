import { describe, it, expect } from "vitest";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { PromptVariable } from "../segments";
import { makeSetup, type Composer } from "../setups";
import { AGENT_PATH, agentBody, agentCurl, agentNotes, agentPrice, agentProbe } from "../agent";

const variable = (name: string, over: Partial<PromptVariable> = {}): PromptVariable => ({
  id: name, name, label: null, description: "", type: "text", defaultValue: null,
  required: false, position: 0, min: null, max: null, options: null, ...over,
});
const model = (over: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  id: "m-gpt", name: "GPT-Image-2 (beta)", price: 0.1, mediaType: "image", supportsQuality: true,
  maxResolution: "4K", ratios: ["1:1", "4:5"], boostTiers: ["2K"], boostAvailable: true, free: false, ...over,
});

const VARS = [
  variable("subject", { label: "Subject" }),
  variable("rain", { type: "checkbox", description: "in heavy rain" }),
  variable("styles", { type: "multi-select" }),
];
const setup = (over: Partial<Composer> = {}) => makeSetup({
  promptId: "p1", title: "Harbour", publicText: "[Subject] [rain] [styles] [sky]", edited: null, variables: VARS,
  values: { subject: "the captain's dog", rain: "false", styles: "", sky: "red" },
  model: model(), resolution: "2K", aspectRatio: "4:5", quality: "medium", boost: true, refs: ["data:a"], ...over,
})!;

describe("agentBody", () => {
  it("is what the x402 route reads: values, model family and settings, never Boost or references", () => {
    expect(agentBody(setup(), VARS)).toEqual({
      promptId: "p1",
      variableValues: { subject: "the captain's dog", rain: "false" },
      modelFamily: "gpt-image-2",
      resolution: "2K",
      aspectRatio: "4:5",
      quality: "medium",
    });
  });

  it("sends a checkbox as \"true\"/\"false\" (the route writes its text), only declared variables, no empty ones", () => {
    const body = agentBody(setup({ values: { subject: "", rain: "true", styles: "ink,oil", sky: "red" } }), VARS)!;
    expect(body.variableValues).toEqual({ rain: "true", styles: "ink,oil" });
  });

  it("leaves quality out where the model has no lever", () => {
    expect("quality" in agentBody(setup({ model: model({ supportsQuality: false }) }), VARS)!).toBe(false);
  });

  it("is null in the blank composer, which has no prompt", () => {
    expect(agentBody(setup({ promptId: undefined }), VARS)).toBeNull();
  });
});

describe("the request an agent copies, and the page's probe", () => {
  const body = agentBody(setup(), VARS)!;

  it("the curl has no X-PAYMENT, so the agent gets the 402 first, and survives an apostrophe", () => {
    const curl = agentCurl("https://enki.art", body);
    expect(curl).toBe(
      `curl -X POST https://enki.art${AGENT_PATH} -H "Content-Type: application/json" -d '${JSON.stringify(body).replace("'", "'\\''")}'`,
    );
    expect(curl).toContain("the captain'\\''s dog");
    expect(curl).not.toMatch(/X-PAYMENT/i);
  });

  it("the probe posts the same body and never an X-PAYMENT header", () => {
    expect(agentProbe(body)).toEqual({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  });
});

describe("agentPrice", () => {
  it("is the 402's price per image", () => {
    expect(agentPrice(402, { error: "X-PAYMENT header is required", accepts: [{ maxAmountRequired: "134000" }] })).toEqual({ price: "$0.134" });
  });

  it("is the route's reason when it will not serve these settings", () => {
    expect(agentPrice(400, { error: "\"\" is not a valid value for style" })).toEqual({ error: "\"\" is not a valid value for style" });
    expect(agentPrice(402, { error: "X-PAYMENT header is required" })).toEqual({ error: "X-PAYMENT header is required" });
    expect(agentPrice(200, { accepts: [{ maxAmountRequired: "134000" }] })).toEqual({ error: "HTTP 200" });
    expect(agentPrice(500, null)).toEqual({ error: "HTTP 500" });
  });
});

describe("agentNotes", () => {
  it("says where the agent's render differs from this page's", () => {
    expect(agentNotes({ premium: true, artistUsd: "0.40", setup: setup({ boost: false, refs: [] }) })).toEqual(["Same $0.40 creator price as here."]);
    expect(agentNotes({ premium: true, artistUsd: null, setup: setup({ boost: false, refs: [] }) })).toEqual([]);
    expect(agentNotes({ premium: false, artistUsd: null, setup: setup({ boost: false, refs: [] }) })).toEqual(["The prompt is free; only generator cost applies."]);
    expect(agentNotes({ premium: false, artistUsd: null, setup: setup({ boost: false, refs: ["data:a"], edited: "[Subject]" }) })).toEqual([
      "The prompt is free; only generator cost applies.",
      "Agents run without Boost and without reference images.",
      "Your edits to the text are not part of the agent request.",
    ]);
    expect(agentNotes({ premium: true, artistUsd: null, setup: setup({ boost: true, refs: [] }) })).toEqual(["Agents run without Boost and without reference images."]);
  });
});
