"use client";

/**
 * The render queue of every generate surface (plan §1.3). Each Generate is one
 * job; jobs run in parallel, while wallet prompts come one at a time. What an
 * outcome does is decided in lib/ui/kit/render-queue `settle`; this hook only
 * carries it out.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { runGeneration, type GenerationRequest } from "@/lib/generation/run-generation";
import type { PaymentSigner } from "@/lib/generation-checkout";
import { usePaymentSigner } from "@/hooks/usePaymentSigner";
import { refreshHoldings } from "@/hooks/useHoldings";
import { openLogin } from "@/lib/openLogin";
import { notify } from "@/components/kit/notify";
import { queueReducer, settle, type FreeQuota, type Job } from "@/lib/ui/kit/render-queue";
import { serialSigner, trackSigner } from "@/lib/ui/kit/serial-signer";

/** Where the editor keeps its jobs across reloads. Pass a stable object. */
export interface JobStore<S> {
  load(): Promise<Job<S>[]>;
  save(jobs: Job<S>[]): void;
}

export function useRenderQueue<S>({ toRequest, persist, onLeave }: {
  toRequest: (setup: S) => GenerationRequest;
  persist?: JobStore<S>;
  /** Runs when the surface unmounts, with the jobs at that moment. */
  onLeave?: (jobs: Job<S>[]) => void;
}) {
  const [jobs, dispatch] = useReducer(queueReducer<S>, []);
  const [note, setNote] = useState<FreeQuota | null>(null);

  // One chain of signatures for the queue's lifetime, always with the current
  // wallet; made on the first Generate, because refs belong to handlers.
  const sign = usePaymentSigner();
  const latestSign = useRef(sign);
  const serial = useRef<PaymentSigner | null>(null);

  const latest = useRef({ jobs, onLeave });
  useEffect(() => {
    latestSign.current = sign;
    latest.current = { jobs, onLeave };
  });
  useEffect(() => () => latest.current.onLeave?.(latest.current.jobs), []);

  const [loaded, setLoaded] = useState(!persist);
  useEffect(() => {
    if (!persist) return;
    let live = true;
    const done = (saved: Job<S>[]) => {
      if (!live) return;
      dispatch({ type: "restore", jobs: saved });
      setLoaded(true);
    };
    persist.load().then(done, () => done([]));
    return () => {
      live = false;
    };
  }, [persist]);
  useEffect(() => {
    // Not before the saved jobs are in, or the empty start would overwrite them.
    if (persist && loaded) persist.save(jobs);
  }, [persist, loaded, jobs]);

  const run = useCallback(
    (setup: S) => {
      const id = crypto.randomUUID();
      dispatch({ type: "enqueue", id, createdAt: Date.now(), setup });
      serial.current ??= serialSigner((transaction) => latestSign.current(transaction));
      const signer = trackSigner(serial.current);
      void runGeneration(toRequest(setup), signer.sign).then((outcome) => {
        const s = settle(id, outcome, signer.state());
        dispatch(s.action);
        if (s.toast) notify(s.toast, s.action.type === "fail" ? { tone: "error" } : undefined);
        if (s.login) openLogin();
        if (s.note) setNote(s.note);
        if (s.refresh) refreshHoldings();
      });
    },
    [toRequest],
  );

  /** A failed job goes, and the same setup runs again at the front. */
  const retry = useCallback(
    (id: string) => {
      const job = jobs.find((j) => j.id === id);
      if (job?.status !== "failed") return;
      dispatch({ type: "drop", id });
      run(job.setup);
    },
    [jobs, run],
  );

  const drop = useCallback((id: string) => dispatch({ type: "drop", id }), []);
  const markSeen = useCallback((id: string) => dispatch({ type: "seen", id }), []);

  return { jobs, run, retry, drop, markSeen, note };
}
