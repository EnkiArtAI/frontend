import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "fixture" }) }));
import { runGeneration } from "@/lib/generation/run-generation";
import { settle } from "../render-queue";
import type { CatalogueEntry } from "@/hooks/useModelLimits";

const model: CatalogueEntry = { id: "fixture-model", name: "Fixture", price: 0.1, mediaType: "image", supportsQuality: false, maxResolution: "1K", ratios: ["1:1"], free: false };
const request = { model, prompt: "fixture prompt", resolution: "1K" as const, aspectRatio: "1:1" };

async function failureAt(path: string) {
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    paths.push(input);
    if (input === path) throw new Error("Connection lost");
    const body = input.endsWith("/intent") ? { intent: { id: "fixture-intent" } }
      : input.endsWith("/authorize") ? { transaction: "fixture-transaction" }
      : { authorized: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const sign = vi.fn(async () => "fixture-signature");
  const out = await runGeneration(request, sign);
  expect(sign).toHaveBeenCalledOnce();
  return { paths, out, ui: settle("fixture-job", out, "signed") };
}

describe("signed failures from the real runner into the shared queue", () => {
  it("submit loses its answer before generation: the UI does not imply a charge", async () => {
    const { paths, out, ui } = await failureAt("/api/payments/generation/submit");
    expect(paths).not.toContain("/api/generate-image");
    expect(out).toMatchObject({ ok: false, phase: "authorization" });
    expect(ui.action).toMatchObject({ type: "fail", error: { charged: "no" } });
    expect(ui.toast).toContain("not charged");
  });

  it("the generation request loses its answer: the UI retains the uncertain outcome", async () => {
    const { paths, out, ui } = await failureAt("/api/generate-image");
    expect(paths.at(-1)).toBe("/api/generate-image");
    expect(out).toMatchObject({ ok: false, phase: "generation" });
    expect(ui.action).toMatchObject({ type: "fail", error: { charged: "unknown" } });
  });
});
