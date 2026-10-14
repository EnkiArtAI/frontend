/**
 * The price chip on Generate and the balance in the cost line. Every number is
 * the server's: without a quote there is no price, never a guess.
 */
import type { GenerationQuote } from "@/lib/generation-checkout";

/**
 * The chip: "$0.00" on the free host (never the word "free", plan R30), the
 * server's total, "…" while it is being asked, and nothing when there is no
 * price to show (signed out, prompt unavailable, quote failed).
 */
export function chipLabel({ signedIn, free, quote, pending }: {
  signedIn: boolean;
  free: boolean;
  quote: GenerationQuote | null;
  pending: boolean;
}): string | null {
  if (!signedIn) return null;
  if (free) return "$0.00";
  if (quote) return `$${quote.totalUsd}`;
  return pending ? "…" : null;
}

/** Whether a render costs more than the balance, in integer micro-USDC: a float sum like $0.10 + $0.20 is not $0.30. */
export const overBalance = (balanceUsd: number, totalMicro: number) => Math.round(balanceUsd * 1_000_000) < totalMicro;

/**
 * The balance next to the price, or null where it would mislead: no payer, an
 * EVM address (it always reads $0.00, plan R27), or the free host (nothing to
 * pay). `short` turns it red; Generate stays clickable (handoff §0 "Balance").
 */
export function balanceView({ payer, ready, balance, free, quote }: {
  payer: string | null;
  ready: boolean;
  balance: number;
  free: boolean;
  quote: GenerationQuote | null;
}): { text: string; short: boolean } | null {
  if (!payer || payer.startsWith("0x") || free) return null;
  if (!ready) return { text: "…", short: false };
  return { text: `$${balance.toFixed(2)}`, short: quote !== null && overBalance(balance, quote.totalMicro) };
}
