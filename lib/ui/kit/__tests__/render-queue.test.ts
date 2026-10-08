import { describe, it, expect } from "vitest";
import { queueReducer, viewerList, leaveSummary, settle, quotaText, type Job, type QueueAction } from "../render-queue";
import type { GenerationOutcome } from "@/lib/generation/run-generation";

type S = { prompt: string };
const run = (actions: QueueAction<S>[], from: Job<S>[] = []) => actions.reduce(queueReducer<S>, from);
const enqueue = (id: string): QueueAction<S> => ({ type: "enqueue", id, createdAt: 1, setup: { prompt: id } });
const job = (id: string, status: Job<S>["status"], seen = false): Job<S> => ({ id, createdAt: 1, status, setup: { prompt: id }, seen });

describe("queueReducer", () => {
  it("prepends a new job as rendering and unseen, and moves nothing else", () => {
    const jobs = run([enqueue("a"), enqueue("b")]);
    expect(jobs.map((j) => j.id)).toEqual(["b", "a"]);
    expect(jobs[0]).toEqual({ id: "b", createdAt: 1, setup: { prompt: "b" }, status: "rendering", seen: false });
  });

  it("resolves a rendering job in place, with its size", () => {
    const jobs = run([enqueue("a"), enqueue("b"), { type: "resolve", id: "a", imageUrl: "https://x/a.webp", size: { w: 8, h: 10 } }]);
    expect(jobs.map((j) => j.id)).toEqual(["b", "a"]);
    expect(jobs[1]).toMatchObject({ status: "ready", imageUrl: "https://x/a.webp", size: { w: 8, h: 10 } });
  });

  it("fails a rendering job in place", () => {
    const error = { message: "Render failed · not charged · no", charged: "no" } as const;
    const jobs = run([enqueue("a"), enqueue("b"), { type: "fail", id: "a", error }]);
    expect(jobs[1]).toMatchObject({ id: "a", status: "failed", error });
  });

  it("resolves and fails only a rendering job, and only once", () => {
    const ready = run([enqueue("a"), { type: "resolve", id: "a", imageUrl: "u1" }]);
    expect(run([{ type: "resolve", id: "a", imageUrl: "u2" }], ready)).toBe(ready);
    expect(run([{ type: "fail", id: "a", error: { message: "m", charged: "no" } }], ready)).toBe(ready);
    const failed = run([enqueue("b"), { type: "fail", id: "b", error: { message: "m", charged: "no" } }]);
    expect(run([{ type: "resolve", id: "b", imageUrl: "u" }], failed)).toBe(failed);
    expect(run([{ type: "resolve", id: "nope", imageUrl: "u" }], failed)).toBe(failed);
  });

  it("drops a job", () => {
    expect(run([enqueue("a"), enqueue("b"), { type: "drop", id: "a" }]).map((j) => j.id)).toEqual(["b"]);
  });

  it("marks only a ready job seen", () => {
    const jobs = run([{ type: "seen", id: "r" }, { type: "seen", id: "x" }, { type: "seen", id: "f" }], [job("r", "ready"), job("x", "rendering"), job("f", "failed")]);
    expect(jobs.map((j) => j.seen)).toEqual([true, false, false]);
    expect(run([{ type: "seen", id: "r" }], jobs)).toBe(jobs);
  });

  it("restores saved jobs after the current ones; a rendering one becomes failed, Interrupted", () => {
    const jobs = run([enqueue("new"), { type: "restore", jobs: [job("old", "rendering"), job("done", "ready", true), job("new", "failed")] }]);
    expect(jobs.map((j) => [j.id, j.status])).toEqual([["new", "rendering"], ["old", "failed"], ["done", "ready"]]);
    expect(jobs[1].error).toEqual({ message: "Interrupted — the image may be in your gallery", charged: "unknown" });
    expect(jobs[2]).toEqual(job("done", "ready", true));
  });
});

describe("selectors", () => {
  const jobs = [job("r2", "ready"), job("x", "rendering"), job("f", "failed"), job("r1", "ready", true)];

  it("viewerList is the ready jobs in queue order", () => {
    expect(viewerList(jobs).map((j) => j.id)).toEqual(["r2", "r1"]);
  });

  it("leaveSummary counts ready and rendering jobs, never failed ones", () => {
    expect(leaveSummary(jobs)).toBe("2 renders saved to History · 1 still rendering");
    expect(leaveSummary([job("r", "ready"), job("f", "failed")])).toBe("1 render saved to History");
    expect(leaveSummary([job("x", "rendering"), job("y", "rendering")])).toBe("2 still rendering · finished ones land in History");
    expect(leaveSummary([job("r", "ready"), job("s", "ready")], "My Gallery")).toBe("2 renders saved to My Gallery");
    expect(leaveSummary([job("x", "rendering")], "My Gallery")).toBe("1 still rendering · finished ones land in My Gallery");
    expect(leaveSummary([job("f", "failed")])).toBeNull();
    expect(leaveSummary([])).toBeNull();
  });
});

describe("settle (the outcome table)", () => {
  const ok = (data: Record<string, unknown>): GenerationOutcome => ({ ok: true, imageUrl: "https://x/i.webp", data });
  const bad = (error: string, status?: number, data?: Record<string, unknown>): GenerationOutcome => ({ ok: false, error, status, data });

  it("ok: resolves with the measured size when it is numeric", () => {
    expect(settle("j", ok({ width: 896, height: 1152 }), "none")).toEqual({
      action: { type: "resolve", id: "j", imageUrl: "https://x/i.webp", size: { w: 896, h: 1152 } },
      refresh: false,
    });
    expect(settle("j", ok({ width: null, height: 1152 }), "none").action).toEqual({ type: "resolve", id: "j", imageUrl: "https://x/i.webp", size: undefined });
    expect(settle("j", ok({ width: 896 }), "none").action).toMatchObject({ size: undefined });
  });

  it("ok after signing: the balance is read again", () => {
    expect(settle("j", ok({}), "signed").refresh).toBe(true);
  });

  it("the signer was cancelled: the job goes, nothing was charged", () => {
    expect(settle("j", bad("Signing was cancelled — nothing was charged"), "threw")).toEqual({
      action: { type: "drop", id: "j" },
      toast: "Cancelled in your wallet · nothing was charged",
    });
    // authorizePaidGeneration's own rule, in case a wallet's words come through unchanged.
    expect(settle("j", bad("User rejected the request."), "threw").action).toEqual({ type: "drop", id: "j" });
    expect(settle("j", bad("Transaction denied"), "threw").action).toEqual({ type: "drop", id: "j" });
  });

  it("a server sentence that says cancelled is still a failure when the wallet did not throw", () => {
    expect(settle("j", bad("The provider cancelled the job", 502), "signed").action).toMatchObject({ type: "fail", error: { charged: "no" } });
  });

  it("the signer failed otherwise: a failed job, not charged", () => {
    expect(settle("j", bad("The wallet could not sign — nothing was charged"), "threw")).toEqual({
      action: { type: "fail", id: "j", error: { message: "Render failed · not charged · The wallet could not sign — nothing was charged", charged: "no" } },
      toast: "Render failed · not charged · The wallet could not sign — nothing was charged",
    });
  });

  it("401 sign-in required: the job goes and the login opens", () => {
    expect(settle("j", bad("Sign in to generate for free.", 401, { signInRequired: true }), "none")).toEqual({ action: { type: "drop", id: "j" }, login: true });
  });

  it("402 free quota used up: the job goes and the note says so", () => {
    // A lowered limit can leave `used` above it.
    const s = settle("j", bad("You have used all 3 free generations on this account.", 402, { freeQuotaExhausted: true, used: 5, limit: 3 }), "none");
    expect(s).toEqual({ action: { type: "drop", id: "j" }, note: { used: 5, limit: 3 }, toast: "Free renders used up (5 of 3)" });
    expect(quotaText({ used: 2, limit: 5 })).toBe("Free renders used up (2 of 5)");
  });

  it("never signed, a free-route failure, or signed with an HTTP answer: failed, not charged", () => {
    const failed = (o: GenerationOutcome, sign: "none" | "signed") => settle("j", o, sign).action;
    expect(failed(bad("Could not prepare the payment"), "none")).toEqual({ type: "fail", id: "j", error: { message: "Render failed · not charged · Could not prepare the payment", charged: "no" } });
    expect(failed(bad("Failed to fetch"), "none")).toMatchObject({ error: { charged: "no" } });
    expect(failed(bad("Unauthorized", 401), "none")).toMatchObject({ type: "fail", error: { charged: "no" } });
    expect(failed(bad("This prompt renders only on a paid model.", 402), "none")).toMatchObject({ type: "fail", error: { charged: "no" } });
    expect(failed(bad("Moderation refused it", 422), "signed")).toEqual({ type: "fail", id: "j", error: { message: "Render failed · not charged · Moderation refused it", charged: "no" } });
  });

  it("429 reads busy", () => {
    expect(settle("j", bad("Rate limit exceeded", 429), "signed")).toEqual({
      action: { type: "fail", id: "j", error: { message: "Busy right now · not charged · Rate limit exceeded", charged: "no" } },
      toast: "Busy right now · not charged · Rate limit exceeded",
    });
  });

  it("signed and no HTTP answer: charged is unknown", () => {
    const message = "Connection lost · if the image was made it appears in your gallery, charged only then";
    expect(settle("j", bad("Failed to fetch"), "signed")).toEqual({ action: { type: "fail", id: "j", error: { message, charged: "unknown" } }, toast: message });
  });
});
