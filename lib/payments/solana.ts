/**
 * The Solana side of generation payments: which chain, which connection, and
 * the one keypair that signs everything Enki signs.
 *
 * Chain resolution matches lib/usdc-balance.ts exactly, so a balance is always
 * read from the chain a payment settles on. Nothing here is a request
 * parameter — a client that could pick the chain could pick devnet and pay in
 * play money.
 *
 * ── The fee payer ───────────────────────────────────────────────────────
 * Enki pays every fee (Terms of Use, Section 4). That is not generosity: our
 * buyers onboard through Coinbase Onramp and hold USDC, not SOL, so a fee
 * pushed onto them does not get collected — it surfaces as a generation that
 * fails for a reason they cannot act on. At ~0.13 cents per generation the
 * alternative costs more in lost checkouts than it saves.
 *
 * The same keypair is the NONCE AUTHORITY, and that part is structural rather
 * than economic: voiding an authorisation whose buyer has closed the tab is
 * only possible if we can act on the nonce alone. Hand that authority to the
 * buyer and abandoned authorisations could never be flushed.
 */
import { Connection, Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import bs58 from "bs58";
import { PAYMENT_CHAINS, isSolanaChain, type ChainKey } from "@/shared/payment-config";

/**
 * WHICH Solana chain this deployment settles on — the key, not the config.
 *
 * Exported because the generate route was taking it from the client instead:
 * `chain as "solana" | "solana-devnet"` straight off a query parameter, while
 * the fee payer, the RPC connection and the USDC mint all came from here. Two
 * sources of truth for one decision, and the one a stranger controls was
 * winning for the half of the code that read the query string.
 */
export function solanaChainKey(): ChainKey {
  const key = (process.env.SOLANA_PAYMENT_CHAIN ||
    process.env.SOLANA_FUND_CHAIN ||
    "solana-devnet") as ChainKey;
  if (!(key in PAYMENT_CHAINS) || !isSolanaChain(key)) {
    throw new Error(`Not a Solana chain key: ${key}`);
  }
  return key;
}

export function solanaChain(): { rpcUrl: string; usdc: string } {
  // || rather than ??: a `.env` line reading `SOLANA_PAYMENT_CHAIN=` puts an
  // EMPTY STRING in the environment, and ?? treats that as a real value —
  // found on the devnet dry run, where it made every payment path throw
  // "Not a Solana chain key: ".
  const key = (process.env.SOLANA_PAYMENT_CHAIN ||
    process.env.SOLANA_FUND_CHAIN ||
    "solana-devnet") as ChainKey;
  if (!(key in PAYMENT_CHAINS) || !isSolanaChain(key)) {
    throw new Error(`Not a Solana chain key: ${key}`);
  }
  return PAYMENT_CHAINS[key] as { rpcUrl: string; usdc: string };
}

export function usdcMint(): PublicKey {
  return new PublicKey(solanaChain().usdc);
}

/**
 * The RPC endpoints, in the order they are tried.
 *
 * SOLANA_RPC_URL overrides ONLY on mainnet. The var holds one URL and a URL
 * is chain-specific — on 2026-08-24 a mainnet Helius URL sat in the env of a
 * devnet deployment and every settlement died with the RPC's 401 instead of
 * reaching the (free, public) devnet RPC the chain config already named.
 * SOLANA_RPC_URL_FALLBACK, a second provider, follows the same rule (ENG-12:
 * with one URL, an outage at that provider stopped every payment), and the
 * chain's public endpoint comes last.
 */
export function solanaRpcUrls(): string[] {
  const mainnet = solanaChainKey() === "solana";
  const urls = [
    mainnet ? process.env.SOLANA_RPC_URL : undefined,
    mainnet ? process.env.SOLANA_RPC_URL_FALLBACK : undefined,
    solanaChain().rpcUrl,
  ].map((u) => u?.trim()).filter((u): u is string => Boolean(u) && parses(u!));
  return [...new Set(urls)];
}

/** A URL that cannot be parsed is dropped, by name only: it may carry a key. */
function parses(url: string): boolean {
  try {
    return Boolean(new URL(url));
  } catch {
    console.error("[solana-rpc] an RPC URL in the environment cannot be parsed and is skipped");
    return false;
  }
}

/**
 * "confirmed" rather than "finalized": a confirmed payment is one the cluster
 * has agreed on, and waiting the extra ~13s for finality would sit in the
 * user's checkout for no gain we can act on.
 */
export function solanaConnection(): Connection {
  const urls = solanaRpcUrls();
  return new Connection(urls[0], urls.length > 1 ? { commitment: "confirmed", fetch: failover(urls) } : "confirmed");
}

/**
 * The next endpoint is tried only when one cannot answer: a network error, a
 * 5xx, a refused key (401, 403), a spent quota or rate limit (429), or no
 * headers within RPC_ATTEMPT_MS. Those are refusals before the request was
 * handled. An answer is final, a JSON-RPC error included (a rejected
 * transaction comes back as HTTP 200), so nothing rejected is re-sent
 * elsewhere. Re-sending after an endpoint that timed out is safe: a signed
 * transaction has one signature and lands at most once, and the sender
 * confirms rather than believes a failed send (broadcastAndConfirm).
 */
const RPC_ATTEMPT_MS = 10_000;
const UNANSWERED = new Set([401, 403, 429]);
function failover(urls: string[]): typeof fetch {
  return async (_input, init) => {
    for (let i = 0; ; i++) {
      const last = i === urls.length - 1;
      const ac = last ? null : new AbortController();
      const timer = ac && setTimeout(() => ac.abort(), RPC_ATTEMPT_MS);
      try {
        const res = await fetch(urls[i], ac ? { ...init, signal: ac.signal } : init);
        if (last || (res.status < 500 && !UNANSWERED.has(res.status))) return res;
      } catch (e) {
        if (last) throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
      reportDown(urls[i]);
    }
  };
}

/**
 * Wait for "confirmed" by asking over HTTP. web3.js confirms on the FIRST
 * endpoint's websocket, which is down exactly when the failover is needed;
 * these questions go through the failover like every other call. Throws when
 * the transaction failed on chain, when its blockhash expired (it can no
 * longer land), or at the timeout, whose message the agent route reads.
 */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  { lastValidBlockHeight, timeoutMs = 60_000 }: { lastValidBlockHeight?: number; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = (await connection.getSignatureStatuses([signature])).value[0];
    if (s?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return;
    if (lastValidBlockHeight !== undefined && (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      throw new Error("Transaction expired before it landed");
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for confirmation");
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

/**
 * Send a signed transaction and confirm it (confirmSignature). A rejection
 * is final, except "already processed": the failover re-sends after an
 * endpoint that cannot answer, and one that timed out may have forwarded it
 * first. A send that failed in transit may have landed too, so both are
 * confirmed rather than believed.
 */
export async function broadcastAndConfirm(
  connection: Connection,
  raw: Uint8Array,
  signature: string,
  opts?: { lastValidBlockHeight?: number; timeoutMs?: number },
): Promise<void> {
  try {
    await connection.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 3 });
  } catch (e) {
    if (e instanceof SendTransactionError && !/already been processed/i.test(e.message)) throw e;
  }
  await confirmSignature(connection, signature, opts);
}

const reported = new Set<string>();
/** Logged with the host only: a provider URL carries its API key in the query. */
function reportDown(url: string): void {
  const host = new URL(url).host;
  console.error(`[solana-rpc] ${host} did not answer; trying the next endpoint`);
  if (reported.has(host)) return;
  reported.add(host);
  // One mail per instance, not per request.
  void Promise.all([import("@/lib/admin-notify"), import("@/lib/supabaseServer")])
    .then(([{ notifyAdmins }, { getSupabaseServerClientSafe }]) => {
      const db = getSupabaseServerClientSafe();
      return db && notifyAdmins(db, { subject: "Solana RPC failover", text: `${host} did not answer. Payments moved to the next RPC endpoint.` });
    })
    .catch(() => {});
}

let cachedFeePayer: Keypair | null = null;

/**
 * The fee payer and nonce authority.
 *
 * Accepts base58 or a solana-keygen JSON array, the same two shapes
 * SOLANA_TREASURY_SECRET_KEY documents. Errors deliberately say only that
 * parsing failed: a message quoting the value, its length, or its prefix would
 * put key material into a log line, which is exactly the incident SECRETS.md
 * exists to prevent.
 */
export function feePayerKeypair(): Keypair {
  if (cachedFeePayer) return cachedFeePayer;

  const raw = process.env.SOLANA_FEE_PAYER_SECRET_KEY?.trim();
  if (!raw) throw new Error("SOLANA_FEE_PAYER_SECRET_KEY is not set");

  let bytes: Uint8Array;
  try {
    bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  } catch {
    throw new Error("SOLANA_FEE_PAYER_SECRET_KEY is neither base58 nor a JSON byte array");
  }
  if (bytes.length !== 64) {
    throw new Error("SOLANA_FEE_PAYER_SECRET_KEY is not a 64-byte secret key");
  }

  cachedFeePayer = Keypair.fromSecretKey(bytes);
  return cachedFeePayer;
}

/** Tests and key rotation. */
export function resetFeePayerCache(): void {
  cachedFeePayer = null;
}

/**
 * Below this the fee payer can no longer front a nonce account, and every
 * generation stops. One nonce rent (0.00144768) plus an ATA rent (0.00203928)
 * plus fees is roughly 0.0036 SOL per in-flight generation, so this is about
 * 50 of them — enough warning to top up, not so much that it cries wolf.
 */
export const FEE_PAYER_LOW_LAMPORTS = 200_000_000; // 0.2 SOL

/**
 * Whether the fee payer can still work. Returns the balance so a caller can
 * log or alert on the number rather than just the verdict — an empty fee payer
 * halts ALL generations, and finding that out from a customer complaint is the
 * failure mode worth spending an RPC call to avoid.
 */
export async function feePayerBalance(
  connection: Connection,
): Promise<{ lamports: number; low: boolean }> {
  const lamports = await connection.getBalance(feePayerKeypair().publicKey);
  return { lamports, low: lamports < FEE_PAYER_LOW_LAMPORTS };
}
