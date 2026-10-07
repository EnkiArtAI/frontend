/**
 * The life of one durable nonce account.
 *
 * Kev, 2026-08-06: no pool. One account per intent, created with it and closed
 * at whatever ends it. That is not the more expensive option, it is the
 * cheaper one — closing returns the rent, and it removes the shared resource a
 * pool would need leasing logic for.
 *
 * ── Closing IS the flush ────────────────────────────────────────────────
 * The runtime checks that a nonce account is in the `Initialized` state before
 * honouring a durable-nonce transaction. Withdrawing the full balance deletes
 * the account, so that check fails forever afterwards: the buyer's signed
 * transaction is permanently dead AND the 1,447,680 lamports come back, in one
 * instruction. Advancing the nonce would also kill the signature but leaves
 * the account, and its rent, sitting there.
 *
 * The one wrinkle, from the Anza spec: an account cannot be closed while its
 * stored nonce is still the cluster's most recent blockhash. That is a
 * one-slot condition (~400ms), not a real wait, but a close attempted straight
 * after creation will hit it — so it is retried rather than treated as
 * failure.
 */
import {
  Connection,
  Keypair,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
  NONCE_ACCOUNT_LENGTH,
} from "@solana/web3.js";
import bs58 from "bs58";
import { broadcastAndConfirm } from "@/lib/payments/solana";

/** Sign with a fresh blockhash and confirm over HTTP (broadcastAndConfirm), not a websocket. */
async function sendSigned(connection: Connection, tx: Transaction, signers: Keypair[]): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  await broadcastAndConfirm(connection, tx.serialize(), bs58.encode(tx.signature!), { lastValidBlockHeight });
}

/** ~400ms is one slot; 4 attempts covers a slow cluster without hanging a request. */
const CLOSE_ATTEMPTS = 4;
const CLOSE_RETRY_MS = 600;

export type CloseOutcome = "closed" | "gone" | "failed";

/**
 * Create and initialise a nonce account, with Enki as its authority.
 *
 * The authority matters more than anything else here: it is what lets us void
 * an authorisation whose buyer has walked away. Give it to the buyer and an
 * abandoned signature could never be flushed.
 */
export async function createNonceAccount(
  connection: Connection,
  feePayer: Keypair,
): Promise<{ address: string; nonce: string }> {
  const nonceKeypair = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: feePayer.publicKey,
      newAccountPubkey: nonceKeypair.publicKey,
      lamports: rent,
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    SystemProgram.nonceInitialize({
      noncePubkey: nonceKeypair.publicKey,
      authorizedPubkey: feePayer.publicKey,
    }),
  );

  await sendSigned(connection, tx, [feePayer, nonceKeypair]);

  const nonce = await readNonce(connection, nonceKeypair.publicKey.toBase58());
  if (!nonce) {
    throw new Error("Nonce account was created but holds no nonce");
  }
  return { address: nonceKeypair.publicKey.toBase58(), nonce };
}

/** The stored nonce value, or null if the account is gone or uninitialised. */
export async function readNonce(
  connection: Connection,
  address: string,
): Promise<string | null> {
  const info = await connection.getAccountInfo(new PublicKey(address), "confirmed");
  if (!info) return null;
  try {
    return NonceAccount.fromAccountData(info.data).nonce;
  } catch {
    return null;
  }
}

/**
 * A close that failed because the nonce is still the freshest blockhash is
 * worth retrying; anything else is not. Kept separate from the network call so
 * the classification can be tested — getting it wrong either spins forever or
 * abandons a live nonce after one unlucky attempt.
 */
export function isCooldownError(message: string): boolean {
  return (
    /NonceBlockhashNotExpired/i.test(message) ||
    /nonce blockhash.*not.*expired/i.test(message) ||
    /stored nonce is still in recent/i.test(message)
  );
}

/**
 * Close the account, flushing the authorisation and reclaiming the rent.
 *
 * Idempotent by design: an account that is already gone reports "gone", not an
 * error. The sweeper may well try to flush something a previous run already
 * closed, and that is a success, not a fault.
 */
export async function closeNonceAccount(
  connection: Connection,
  address: string,
  authority: Keypair,
  refundTo: PublicKey = authority.publicKey,
): Promise<CloseOutcome> {
  const noncePubkey = new PublicKey(address);

  for (let attempt = 1; attempt <= CLOSE_ATTEMPTS; attempt++) {
    const info = await connection.getAccountInfo(noncePubkey, "confirmed");
    // Already closed — by us, earlier, or by the capture path's cleanup.
    if (!info) return "gone";

    const tx = new Transaction().add(
      SystemProgram.nonceWithdraw({
        noncePubkey,
        authorizedPubkey: authority.publicKey,
        toPubkey: refundTo,
        // Everything: a partial withdrawal would leave the account alive and
        // the buyer's signature with it.
        lamports: info.lamports,
      }),
    );

    try {
      await sendSigned(connection, tx, [authority]);
      return "closed";
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isCooldownError(message) && attempt < CLOSE_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, CLOSE_RETRY_MS));
        continue;
      }
      console.error(`[payments/nonce] close attempt ${attempt}/${CLOSE_ATTEMPTS} failed:`, message);
      if (attempt >= CLOSE_ATTEMPTS) return "failed";
    }
  }
  return "failed";
}
