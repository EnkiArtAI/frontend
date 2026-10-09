# REC-3 · x402 agent route records the generation (narrowed scope, this PR)

ClickUp: https://app.clickup.com/t/86cbk4ffj · Parent: ENG-07 · Stacked on `feat/rec-1-payment-link-imageid`.

## STOP — two parts of the brief are deliberately NOT done here

**1. The settle-order reorder (durable-nonce → authorize → generate → capture)
is not implemented in this PR.** `docs/specs/REC-3.md`'s own ticket thread
(`tasks/REC-3.md`, KG comments) shows Kev decided this on 2026-09-24 — agents
get the same authorize-then-capture flow as humans — and then, same day:
*"Claude stays off this path; coordinate through this task."* That is a
standing instruction from the product owner, not a stale note: it is dated
the same day as the decision it guards, and nothing in this wave's brief
rescinds it. Building it anyway would mean a second, uncoordinated
implementation of a real-money settlement path a human developer may already
be mid-way through — exactly the kind of collision the instruction exists to
prevent. Flagged to the coordinator; recommend confirming with Kev/the human
dev whether this has landed before any agent attempts it. The route keeps its
current, already-shipped settle-then-generate order (REC-2 already covers
"never deliver a data URL on storage failure" for this path).

**2. "Record under the paying wallet as owner" only happens when that wallet
is already linked to an Enki account.** Checked every path that creates a
`users` row in this repo (signup, wallet-login bridge, `/api/auth/wallet/jwt`):
every one of them requires an email/password account first; a wallet is
*linked* to an existing account via `user_wallets`, never used to mint one on
sight. `generations.user_id` and `generated_images.user_id` are both NOT NULL
FKs to `users.id` (ENG-07/REC-1 ticket text, verified live). An x402 agent
wallet calling this route cold has no `users.id` at all — most of them, by the
nature of the protocol, never will. Recording under it is therefore only
possible for the minority of agent wallets a human has separately linked to
their own Enki account; for the rest, there is no row these tables can
legally hold without either (a) auto-provisioning a `users` row for a bare
wallet address (an identity-creation policy change, with ban/moderation/
quota surface this route explicitly does NOT check today — "this rail never
reads an account's ban, so one filed on an account would stop nobody" — and
free-quota implications if that same row could ever be reached another way),
or (b) relaxing the NOT NULL constraint and adding a wallet-identity column
engines could record against instead, which is a schema decision every other
reader of these two tables would need auditing against. Neither is mine to
decide. Implemented here: recordGeneration runs when `user_wallets` already
has this payer; otherwise the route behaves as it does today, storage-only,
MINUS the pseudo-user string (see below). Flagged as a decision for the
coordinator/Kev with three options and no default taken.

## Problem (what IS fixed here)
1. The image is stored under the literal string `"x402-agent"` as both the
   blob-path namespace and (implicitly) the owner — confirmed, line ~530
   (`storeGeneratedImage(dataUrl, "x402-agent", ...)`). No real identity, even
   when the payer wallet is one Enki actually knows.
2. The content type is hard-coded `image/png` when building the `data:` URL
   handed to `storeGeneratedImage` (confirmed — no measurement of the actual
   bytes anywhere in this file), silently mislabeling anything the provider
   returns in another format (WaveSpeed/Gemini/OpenAI are not all PNG-only).
3. No call to `recordGeneration` anywhere in the file — confirmed, and pinned
   by an EXISTING test (`lib/__tests__/generation-failures.test.ts`, the
   `every failure point records it` describe block) that already counts
   exactly 4 `after(recordGenerationFailure(` calls in this file and asserts
   their exact shape (`txSignature: signature`, `settled.pending`, etc.) — not
   touched by this PR, used here as a map of the file's existing structure.

## Scope
`app/api/x402/generate/route.ts` only, plus a new small helper in
`lib/generation/record.ts` (`resolveUserIdForWallet`) to do the `user_wallets`
lookup. Not touched: the settlement order, `lib/payments/x402-settle.ts`, the
402/requirements shape, moderation, the image check, REC-2's storage-failure
handling (already done, per `COMPLETED_CONTEXT.md`).

## Decisions
- **D1 — the payer's wallet is `verified.payer.toBase58()`.** `verifyAgentPayment`
  (`lib/payments/x402-settle.ts`) already resolves and returns this (the
  TransferChecked authority) on success; the route discarded it before this
  change (only `.ok` was read). No new verification needed — reusing a value
  this request already computed and already trusts.
- **D2 — the storage path always uses the real wallet address**, linked or
  not: `generations/${walletAddress}/...` instead of `generations/x402-agent/...`.
  This is purely a blob-path namespace string inside `storeGeneratedImage`,
  with no FK/NOT NULL implication, so it carries none of D-STOP-2's risk and
  is done unconditionally.
- **D3 — MIME from bytes.** `readImageDimensions` (already used by
  `generate-free/route.ts` for the identical problem) measures width, height
  and format from the actual buffer; the `data:` URL built for
  `storeGeneratedImage` carries that real content type, and the same
  measurement feeds `recordGeneration`'s `output`/`mimeType`.
- **D4 — `recordGeneration` is called via `after()`, not awaited.** Unlike
  REC-1's `generate-image` change, nothing in this route's response needs an
  id back (x402 has no `imageId` contract), so there is no reason to put a
  DB round-trip ahead of the agent's answer. This also means the derivative
  WebP pass needs no splitting here: `storeGeneratedImage` already ran
  earlier in this file (before the image check), synchronously, so its
  `previewUrl`/`thumbnailUrl` are already known and are passed straight into
  `recordGeneration` — the already-tested "caller brought its own, stays as
  given" branch, no new code path in `record.ts`.
- **D5 — a recording failure never withholds or delays the image.**
  `after()` already guarantees it runs post-response; REC-1's
  paid-generation admin alert in `recordGeneration` (added this wave, same
  file) fires here too for free, since this call also sets
  `amountPaidCents`/`transactionHash`.
- **D6 — no `payment_intent_id`.** x402 has no `generation_payment_intents`
  row (that table belongs to the human authorize/capture rail); `paymentIntentId`
  is left `null` for every x402-recorded generation. `transactionHash` is the
  settlement signature (already raw/unredacted in this file — `signature` is
  used verbatim elsewhere, e.g. the `transaction` field in every response).

## Contract
New in `lib/generation/record.ts`: `resolveUserIdForWallet(supabase, address):
Promise<string | null>` — exact-match (not case-insensitive; Solana addresses
are case-sensitive base58) lookup on `user_wallets.address` where
`removed_at is null`, mirroring the same lookup already inlined three times
elsewhere (`session-user.ts`, `auth/wallet/jwt/route.ts`).

`app/api/x402/generate/route.ts`: storage path and (when linked) recorded
owner both use the real payer wallet; `recordGeneration` is called on a
successful, delivered, passed-the-image-check generation when the wallet
resolves to a `users.id`.

## Acceptance Criteria
- **AC1 (done)** Given a successful x402 generation, when the image is
  stored, then its blob path contains the payer's wallet address, never the
  literal string `x402-agent`.
- **AC2 (done)** Given a successful x402 generation whose provider returns a
  non-PNG format, when the image is stored and recorded, then the content
  type/`output.format` reflect the measured bytes, not a hard-coded value.
- **AC3 (done, conditional)** Given a successful x402 generation whose payer
  wallet is already linked to an Enki account (`user_wallets`), when the
  response is built, then one `generations` row and one `generated_images`
  row exist for it with `transaction_hash`/`chain_key`/`amount_paid_cents`
  populated and `user_id` equal to that account's id.
- **AC4 (pending human decision)** Given a payer wallet with no linked
  account (the common case), no equivalent row is written today; whether it
  ever should, and how, is the open decision above — not implemented, not
  guessed.
- **AC5 (not implemented, flagged)** "A provider failure on the x402 path
  voids and never captures" — requires the authorize/capture reorder (D-STOP-1),
  which this PR does not build. Today's actual behavior, unchanged: a
  provider failure AFTER settlement is recorded via the existing
  `recordGenerationFailure` call and answered 502 with the signature, same as
  before this PR, with no automatic void (none exists on this rail yet).
- **AC6 (done)** A recording failure (missing/unlinked wallet, or a thrown
  exception inside `recordGeneration`) never withholds the image: it runs in
  `after()`, strictly after the response is already built.

## Test plan
New `lib/__tests__/x402-records-image.test.ts`:
- static source check: the stored path template no longer contains the
  literal `"x402-agent"` string.
- static source check: `readImageDimensions` (or equivalent byte measurement)
  runs before the `data:` URL used for storage is built, and that URL is not
  hard-coded `image/png`.
- unit test on the new `resolveUserIdForWallet` helper (fake Supabase chain,
  same style as `lib/__tests__/record-payment-link.test.ts`): resolves the
  linked `users.id` for a matching, non-removed `user_wallets` row; resolves
  `null` for no match and for a `removed_at`-set row.
- static source check: `after(recordGeneration(` appears exactly once, gated
  behind the wallet lookup, and the call includes `transactionHash: signature`
  and `chainKey`.

Existing `lib/__tests__/generation-failures.test.ts` (`count(AGENT)).toBe(4)`
and its exact-regex assertions) must stay green, unmodified: nothing here
touches the `recordGenerationFailure` call sites, their order, or their
arguments.

No test touches a live DB, payment rail, Solana RPC, or paid provider; the
Solana/payment pieces of this file are exercised today only via the existing
static-source and `x402-settle.test.ts` suites, neither of which this PR
changes.

## Rollout / rollback
No migration. Rollback is a plain revert — nothing here is additive at the
schema level (no new column, no new table).
