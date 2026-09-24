# Payment Security Patterns (MANDATORY)

Build requirements for every endpoint that moves money (generation payments,
future claim payouts, refunds, withdrawals). Decided by Kev, 2026-07-08,
brought in line with the code on 2026-09-24. PRs touching money paths are
reviewed against this list. Each rule names the file that enforces it today;
a rule marked "not built" is a requirement for code that does not exist yet.

## 1. Server priced, server built, client signed
The client sends only identifiers and option selectors (`promptId`,
`modelFamily`, `resolution`, `boost`, `quality`, `intentId`; schema in
`app/api/payments/generation/intent/route.ts`). `boost` picks the vendor
direct route and `quality` the gpt quality tier; each changes which server
side price applies, never the price itself. Amounts, destinations and the
artist, model cost and Enki fee split are computed on the server from the
database and `lib/pricing.ts`, in integer micro USDC, and the server builds
the transaction from the stored intent row. Nothing the client sent is ever
used as an amount or a destination.

The buyer signs in their own wallet. The server holds no key that can move a
user's funds: the only server keypair is the fee payer
(`SOLANA_FEE_PAYER_SECRET_KEY`, `lib/payments/solana.ts`), which pays
transaction fees and account rent and is the nonce authority. Email OTP,
Turnkey and server side signing of buyer transactions are gone; the routes
under `/api/auth/turnkey/*` and `/api/turnkey/*` no longer exist.

Enforced in: `app/api/payments/generation/intent/route.ts`,
`lib/payments/generation-quote.ts`, `lib/payments/generation-pricing.ts`,
`lib/payments/generation-pay.ts` (`paymentLegs` re-asserts the split from
the row and throws on any inconsistency), `lib/payments/authorize-tx.ts`
("The fee payer is Enki, never the buyer"), `hooks/useCdpSolanaSigner.ts`.

The chain a payment settles on is server decided (`solanaChainKey()` in
`lib/payments/solana.ts`), never a request parameter.

## 2. Atomic one shot state transitions
Any "pay once" action flips its state with a single conditional UPDATE and
proceeds only when exactly one row changed. Never SELECT then UPDATE; async
interleaving double pays even on one Node instance.

Enforced in: `lib/payments/generation-redemption.ts` (`consumed_at` is set
atomically on a `confirmed`, never consumed intent), `lib/payments/authorization.ts`
(capture and void each demand the other be unset, so a race has a loser rather
than two winners), `lib/payments/generation-claim.ts` (the one place a
generation may claim an intent; a row carrying the markers of both the prepaid
and the authorised model is refused, not resolved).

## 3. Replay hardening
- **Durable nonce, one account per intent.** The signed in flow builds a
  durable nonce transaction so the signature can wait unbroadcast while the
  image is made. One nonce account per intent, created at `/authorize`,
  closed by capture or void; closing the account kills the signature for
  good and returns the rent (`lib/payments/nonce.ts`,
  `lib/payments/authorize-tx.ts`).
- **Submit rebuilds and compares.** `/submit` rebuilds the transaction from
  the stored intent and compares it message for message with what the buyer
  returned; only signatures may differ
  (`app/api/payments/generation/submit/route.ts`,
  `lib/payments/authorize-flow.ts`).
- **Signature ledger.** Every settled signature is recorded once in
  `payment_verifications` through `checkAndRecordSolanaSignature`
  (`backend/solana-x402-verifier.ts`); a repeat is refused with 402 on the
  signed in generate route and with 409 on the agent route
  (`app/api/x402/generate/route.ts`). The
  header flow additionally rejects any signature already stored as
  `generation_payment_intents.tx_signature`, so a payment from the intent
  flow cannot be replayed as an `X-PAYMENT` header
  (`app/api/generate-image/route.ts`, `app/api/x402/generate/route.ts`).
- **Step up 2FA is passkeys, opt in.** App side WebAuthn via
  `@simplewebauthn`: a user who enrolled a passkey must present a short lived,
  scope bound `X-StepUp-Token` before a sensitive action; a user without one
  is not gated. The check fails closed on a database error
  (`lib/webauthn.ts` `requireStepUp`, `hooks/usePasskey.ts`,
  `app/api/auth/passkey/*`). Today it gates work deletion
  (`app/api/generations/[id]/route.ts`). Withdrawals and claim payouts must
  use the same gate when they are built. No SMS, no email OTP.
- Intent, authorize and submit are rate limited per IP and per user
  (`lib/rate-limit.ts`, `checkRateLimit` in `lib/auth.ts`).

## 4. Identity before money (claims): not built
No claim payout or withdrawal route exists yet. When one is built: claim
payouts require social proof of the referenced account (X through OAuth
login with that account; Instagram through a one time code posted in bio or
story, verified before payout), verification attempts are rate limited per
profile and per IP, and the payout goes through rule 2, rule 3 and the
passkey step up.

## 5. No withholding, ever (Kev decision, 2026-07-08)
Payouts are never held back or queued for review. Once verification passes,
the payout fires in full at any amount. User wallet withdrawals are never
gated either; wallets are the user's own. Safeguards are non blocking only:
an anomaly notification to the admin after an unusually large payout, and a
modest fee payer float so a compromise of everything else is bounded by the
float rather than by delaying anyone's money.

Built today: the fee payer balance is read before an authorisation and
`FEE_PAYER_LOW_LAMPORTS` (0.2 SOL) marks it low (`lib/payments/solana.ts`,
`app/api/payments/generation/authorize/route.ts`). Auto refill from a
treasury and the anomaly notification are not built.

## 6. Ordered means delivered
Nothing is charged until the image exists. The buyer's signed transaction is
an authorisation, not a payment; it ends exactly one of two ways: capture
(broadcast after the image is durably stored) or void (nonce account closed,
nothing charged). Capture claims the row first and broadcasts second; void
writes the row first and closes the account second; both orders leak a retry
rather than a charge. A claim whose worker is provably gone
(`ABANDONED_AFTER_MS`, 360 s, above the route's 300 s `maxDuration` and the
330 s slot TTL) is voided by `sweepAndFlush`, scheduled with `after()` on
every generate request.

Enforced in: `lib/payments/authorization.ts`, `lib/payments/settle.ts`,
`app/api/generate-image/route.ts` (capture after the `@vercel/blob` `put`
of the image, then `fulfillGenerationIntent`).

The budget ladder must keep its order or a live payment is undone while the
generation still runs: 285 s in process timeout
(`SOLANA_GENERATION_TIMEOUT_MS`), 300 s `maxDuration`, 330 s `SLOT_TTL_MS`
(`lib/generation/concurrency.ts`), 360 s `STALE_CLAIM_MS`
(`lib/payments/generation-redemption.ts`).

## 7. Fee payer discipline
The fee payer co-signs only transactions the server built or verified
instruction by instruction. For the agent flow (`lib/payments/x402-settle.ts`):

- the fee payer is payer only, never an instruction account and never the
  transfer authority;
- the compute unit price is capped (`MAX_CU_PRICE_MICROLAMPORTS`, 5 lamports
  per unit) so priority fees cannot drain the fee payer;
- the transfer is exactly the required amount, to exactly the platform USDC
  ATA, of exactly the configured mint, with decimals pinned by
  `TransferChecked`;
- no address table lookups, every account static;
- only ComputeBudget, spl-token `TransferChecked` and Memo may appear; an
  unknown program is a reject;
- verification is offline, submission runs with preflight, so a forged or
  missing client signature fails simulation before anything lands.

For the signed in flow the same guarantee comes from `/submit` rebuilding the
transaction (rule 3). Confirmation level is `confirmed` on every rail
(`solanaConnection()` in `lib/payments/solana.ts`). The buyer's transaction
carries no ComputeBudget price today. A sampler exists but is not wired:
`priorityFeeMicroLamports()` in `lib/payments/generation-pay.ts` takes the
p75 of recent prioritization fees and caps it at
`MAX_PRIORITY_FEE_MICROLAMPORTS = 1_000_000` (1 lamport per unit); it has no
caller outside tests. That cap is not the 5 lamports per unit cap in rule 7.
Wiring the sampler must keep the buyer's price at or below the rule 7 cap.

## 8. Resolve before you settle
On the agent route, model, route, prompt text and moderation are resolved
before the payment settles, so the only thing between a settled payment and
an image is the provider call (`app/api/x402/generate/route.ts`). On the
signed in flow moderation runs before the intent is claimed. Payment first
would take money for requests the server then refuses.

## 9. Secrets
A message about the fee payer key may say that parsing failed and nothing
else: no value, no length, no prefix (`feePayerKeypair()` in
`lib/payments/solana.ts`). The rules in `SECRETS.md` apply to every file on
this list.
