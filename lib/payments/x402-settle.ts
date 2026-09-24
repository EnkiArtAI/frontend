/**
 * x402 exact-svm settlement — the facilitator half of the agent endpoint.
 *
 * The agent builds and PARTIALLY signs a Solana transaction paying our
 * requirements (one TransferChecked of exactly maxAmountRequired USDC to the
 * platform wallet's ATA, our fee payer as payer), base64s it into the
 * X-PAYMENT header, and we: verify OFFLINE, co-sign as fee payer, submit
 * with preflight, and only then run the paid work. Spec:
 * github.com/coinbase/x402 /specs/schemes/exact/scheme_exact_svm.md.
 *
 * Every check here guards OUR key or OUR money:
 *  - the fee payer must be payer only — never an instruction account, never
 *    the transfer authority (a tx that spends the fee payer's own funds
 *    would otherwise be co-signed blind);
 *  - compute-budget price is capped so a hostile tx cannot drain the fee
 *    payer through priority fees;
 *  - the transfer must be EXACTLY the required amount to EXACTLY the
 *    platform ATA of EXACTLY the USDC mint, decimals pinned;
 *  - no address-table lookups: every account must be static, or the checks
 *    above would be reading indices into accounts we cannot see;
 *  - nothing but ComputeBudget, spl-token TransferChecked and Memo may
 *    appear — an unknown program is an automatic reject, not a warning.
 *
 * Verification is pure (no network); the chain itself is the final
 * cryptographic arbiter — submission runs WITH preflight, so a missing or
 * forged client signature fails simulation before anything lands.
 */
import {
  Connection, Keypair, PublicKey, VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** TransferChecked's instruction discriminator in the spl-token program. */
const TRANSFER_CHECKED = 12;
const USDC_DECIMALS = 6;
/** 5 lamports per compute unit, the spec's ceiling for facilitator safety.
    BigInt() call, not a literal — the build targets pre-ES2020 (the same
    constraint that broke the dotAll regex, commit 56ac127). */
const MAX_CU_PRICE_MICROLAMPORTS = BigInt(5_000_000);

export interface X402PaymentEnvelope {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { transaction: string };
}

export type ParseResult =
  | { ok: true; tx: VersionedTransaction }
  | { ok: false; error: string };

/** Decode the X-PAYMENT header down to a deserialized transaction. */
export function parseXPayment(header: string): ParseResult {
  let envelope: X402PaymentEnvelope;
  try {
    envelope = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, error: "X-PAYMENT is not base64-encoded JSON" };
  }
  if (envelope?.scheme !== "exact") return { ok: false, error: `Unsupported scheme: ${envelope?.scheme}` };
  if (typeof envelope?.network !== "string" || !envelope.network.startsWith("solana")) {
    return { ok: false, error: `Unsupported network: ${envelope?.network}` };
  }
  const b64 = envelope?.payload?.transaction;
  if (typeof b64 !== "string" || !b64) return { ok: false, error: "payload.transaction missing" };
  try {
    // VersionedMessage.deserialize handles both v0 and legacy wire formats.
    return { ok: true, tx: VersionedTransaction.deserialize(Buffer.from(b64, "base64")) };
  } catch {
    return { ok: false, error: "payload.transaction is not a valid Solana transaction" };
  }
}

/**
 * One required transfer inside the payment: `owner`'s USDC account must
 * receive exactly `amountMicro`. A plain generation has one leg (platform);
 * an artist-prompt purchase has two (artist + platform) — the SAME atomic
 * source-split the human rails settle with, so the artist is paid by the
 * buyer's own transaction, never out of platform custody.
 */
export interface PaymentLegSpec {
  owner: PublicKey;
  amountMicro: number;
}

export interface VerifyParams {
  /** Every transfer the transaction MUST contain — no more, no fewer. */
  legs: PaymentLegSpec[];
  /** The USDC mint of the deployment's chain. */
  mint: PublicKey;
  /** Our fee payer — must be payer ONLY. */
  feePayer: PublicKey;
}

export type VerifyResult =
  | { ok: true; payer: PublicKey }
  | { ok: false; error: string };

/** Offline verification of the agent's partially-signed transaction. */
export function verifyAgentPayment(tx: VersionedTransaction, p: VerifyParams): VerifyResult {
  const msg = tx.message;

  if ((msg.addressTableLookups?.length ?? 0) > 0) {
    return { ok: false, error: "Address table lookups are not accepted — use static account keys" };
  }

  const keys = msg.staticAccountKeys;
  if (!keys.length || !keys[0].equals(p.feePayer)) {
    return { ok: false, error: "Transaction fee payer must be the feePayer from the 402 requirements" };
  }

  // Legs still to be satisfied, keyed by expected destination ATA.
  const wanted = p.legs.map((l) => ({
    dest: getAssociatedTokenAddressSync(p.mint, l.owner),
    amount: BigInt(l.amountMicro),
    owner: l.owner,
  }));
  let payer: PublicKey | null = null;

  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program) return { ok: false, error: "Instruction references a missing program key" };
    const data = Buffer.from(ix.data);

    if (program.toBase58() === COMPUTE_BUDGET_PROGRAM) {
      // 2 = SetComputeUnitLimit (u32), 3 = SetComputeUnitPrice (u64).
      if (data[0] === 3) {
        if (data.length < 9 || data.readBigUInt64LE(1) > MAX_CU_PRICE_MICROLAMPORTS) {
          return { ok: false, error: "Compute unit price exceeds the facilitator ceiling" };
        }
      } else if (data[0] !== 2) {
        return { ok: false, error: "Only compute unit limit/price budget instructions are accepted" };
      }
      continue;
    }
    if (program.toBase58() === MEMO_PROGRAM) continue;

    if (program.equals(TOKEN_PROGRAM_ID)) {
      if (data[0] !== TRANSFER_CHECKED) return { ok: false, error: "Token instruction must be TransferChecked" };
      if (data.length < 10 || data[9] !== USDC_DECIMALS) {
        return { ok: false, error: "TransferChecked decimals must be 6 (USDC)" };
      }
      const amount = data.readBigUInt64LE(1);
      // TransferChecked accounts: source, mint, destination, authority.
      const [, mintIdx, destIdx, authIdx] = ix.accountKeyIndexes;
      const mint = keys[mintIdx], dest = keys[destIdx], authority = keys[authIdx];
      if (!mint?.equals(p.mint)) return { ok: false, error: "Transfer mint is not this deployment's USDC" };
      if (!authority) return { ok: false, error: "Transfer authority is missing" };
      // ONE buyer pays every leg — a second authority would mean co-signing
      // a stranger's transfer.
      if (payer && !payer.equals(authority)) {
        return { ok: false, error: "All transfers must share one authority" };
      }
      const at = wanted.findIndex((w) => dest?.equals(w.dest) && amount === w.amount);
      if (at < 0) {
        return {
          ok: false,
          error: `Unexpected transfer of ${amount} micro-USDC — the requirements' extra.legs list every required transfer (recipient and exact amount)`,
        };
      }
      wanted.splice(at, 1);
      payer = authority;
      continue;
    }

    return { ok: false, error: `Program ${program.toBase58()} is not accepted in a payment transaction` };
  }

  if (wanted.length > 0) {
    return {
      ok: false,
      error: `Missing transfer of ${wanted[0].amount} micro-USDC to ${wanted[0].owner.toBase58()} — build one TransferChecked per entry in extra.legs`,
    };
  }
  const transfer = payer ? { payer } : null;
  if (!transfer) return { ok: false, error: "No USDC TransferChecked instruction found" };

  // Fee payer safety: payer only. Any instruction touching it could spend it.
  const feePayerTouched = msg.compiledInstructions.some((ix) =>
    ix.accountKeyIndexes.some((i) => keys[i]?.equals(p.feePayer)),
  );
  if (feePayerTouched) {
    return { ok: false, error: "The fee payer may not appear in any instruction account" };
  }

  // The paying authority must be a REQUIRED SIGNER with a signature present.
  // (Cryptographic validity is the chain's job — submission runs preflight.)
  const authIdx = keys.findIndex((k) => k.equals(transfer!.payer));
  if (authIdx < 0 || authIdx >= msg.header.numRequiredSignatures) {
    return { ok: false, error: "Transfer authority is not a required signer of the transaction" };
  }
  const sig = tx.signatures[authIdx];
  if (!sig || sig.every((b) => b === 0)) {
    return { ok: false, error: "Transfer authority has not signed the transaction" };
  }

  return { ok: true, payer: transfer.payer };
}

/**
 * Co-sign as fee payer and return the transaction signature WITHOUT
 * submitting — the signature is deterministic, so the caller can run its
 * replay guard on it before anything is broadcast.
 */
export function cosignAsFeePayer(tx: VersionedTransaction, feePayer: Keypair): string {
  tx.sign([feePayer]);
  return bs58.encode(tx.signatures[0]);
}

/**
 * Submit WITH preflight (unlike the durable-nonce rails): this is a normal
 * recent-blockhash transaction, and preflight simulation is what rejects a
 * forged client signature or an empty payer balance before anything lands.
 */
export type SubmitOutcome =
  | { ok: true; signature: string }
  /** `kind` is a class name, safe to persist; `error` may quote the RPC. */
  | { ok: false; kind: string; error: string; signature?: string };

export async function submitAndConfirm(
  connection: Connection,
  tx: { serialize(): Uint8Array },
  timeoutMs = 45_000,
): Promise<SubmitOutcome> {
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(Buffer.from(tx.serialize()), { maxRetries: 3 });
  } catch (e) {
    return {
      ok: false,
      kind: e instanceof Error ? e.name : "Error",
      error: e instanceof Error ? e.message : "Transaction submission failed",
    };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await connection.getSignatureStatuses([signature]);
    const s = st.value[0];
    if (s?.err) {
      return { ok: false, kind: "TransactionError", error: `Transaction failed on-chain: ${JSON.stringify(s.err)}`, signature };
    }
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      return { ok: true, signature };
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return { ok: false, kind: "ConfirmTimeout", error: "Timed out waiting for confirmation", signature };
}

/** The X-PAYMENT-RESPONSE header body the spec asks for on success. */
export function paymentResponseHeader(signature: string, network: string, feePayer: PublicKey): string {
  return Buffer.from(
    JSON.stringify({ success: true, transaction: signature, network, payer: feePayer.toBase58() }),
  ).toString("base64");
}
