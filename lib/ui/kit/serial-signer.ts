/**
 * Wallet prompts one at a time (plan R7). An external wallet holds a single
 * sign request, so a second one sent while the first is open gets lost. Only
 * the signature waits its turn: the generations themselves still overlap.
 * What runs at the turn is handed over per call, so it is decided then, not
 * when the turn was taken.
 */
import type { PaymentSigner } from "@/lib/generation-checkout";

export type SerialTurn = (sign: () => Promise<string>) => Promise<string>;

export function serialSigner(): SerialTurn {
  let turn: Promise<unknown> = Promise.resolve();
  return (sign) => {
    const mine = turn.then(sign);
    // The next request waits until this one settles, signed or refused.
    turn = mine.catch(() => undefined);
    return mine;
  };
}

/** What one job's signer did: never asked (free route, or failed before signing), signed, or threw. */
export type SignState = "none" | "signed" | "threw";

/** One job's view of the signer: `sign` passes through, `state()` says what happened. */
export function trackSigner(sign: PaymentSigner): { sign: PaymentSigner; state: () => SignState } {
  let state: SignState = "none";
  return {
    sign: (transaction) =>
      sign(transaction).then(
        (signed) => {
          state = "signed";
          return signed;
        },
        (e: unknown) => {
          state = "threw";
          throw e;
        },
      ),
    state: () => state,
  };
}
