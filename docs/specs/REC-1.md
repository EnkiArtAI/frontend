# REC-1 · Payment link + imageId (narrowed scope, this PR)

ClickUp: https://app.clickup.com/t/86cbk4ffg · Parent: ENG-07

## Done already (verified on main @be6fe5e7, not re-touched here)
- `promptId` comes from the intent (`generate-image/route.ts` redemption path).
- `chainKey` from `solanaChainKey()`.
- Free quota counts claims, not generations.
- `lib/generation/record.ts` already has `transactionHash`/`chainKey`/`amountPaidCents`
  fields on `GenerationRecord` and already writes `transaction_hash`, `chain_key`,
  `amount_paid_cents` into `generations` (lines ~176-178). No migration file in
  `migrations/` adds these three columns, but `ENG-07`'s "Why" section records 9 live
  rows in `generations` written by this same insert path (free/Pollinations, since
  2026-08-06 when these fields were added) — if the columns didn't exist the insert
  would fail outright (PostgREST 400) for every row, free or paid, and none would
  exist. Treated as live schema fact per the coordinator's evidence; flagged below as
  a documentation gap, not re-derived from a live probe (no DB credentials here).

## Problem (this PR's scope)
1. `app/api/generate-image/route.ts` never passes `transactionHash` or
   `amountPaidCents` to `recordGeneration` — both are always null for every paid,
   logged-in generation, even though the columns are written.
2. `payment_intent_id` does not exist anywhere in the repo: not on `GenerationRecord`,
   not in the `generations` insert, and (confirmed via `grep -rn` over `migrations/`)
   no migration adds the column to `generations` either. It must be added end to end.
3. The generate-image response never carries an id for the row the gallery reads
   (`generated_images.id` — confirmed by `app/api/images/[id]/route.ts`, the only
   route that already keys off that id). Nothing in the repo reads `imageId` today
   (zero grep hits), so this is new, not a rename.

## Scope
In scope: `app/api/generate-image/route.ts` (the paid, logged-in human path) and
`lib/generation/record.ts`. Out of scope, explicitly decided: `generate-free`'s
`recordGeneration` call (different owner surface, not part of the narrowed task),
the mime-type fix, and REC-2's store-first/void pattern (already done; not touched).
REC-3 (x402) stacks a separate PR on top of this branch.

## Decisions
- **D1 — `imageId` is `generated_images.id`**, not `generations.id`. That is the row
  every existing `[id]`-keyed route and the gallery/share-preview work (ENG-07's
  stated unblock) actually reads by id.
- **D2 — `recordGeneration`'s return type changes** from `Promise<string | null>` to
  `Promise<{ generationId: string; imageId: string | null } | null>`. Checked every
  caller (`app/api/generate-image/route.ts`, `app/api/generate-free/route.ts`): both
  call it inside a floating/`after()` promise and never read the return value today,
  so this is a non-breaking contract widening. `generated_images` insert gains
  `.select("id").single()` to produce it.
- **D3 — `recordGeneration` must be awaited before the response**, not fired into
  `after()`, because `imageId` cannot travel in a response already sent. This is the
  one behavior change with a latency cost: the `generations` + `generation_reference_images`
  + `generated_images` inserts now run in the request's critical path for the paid
  route. Bounded: all are single-row Postgres inserts through PostgREST, not calls to
  Blob/R2 or any provider.
- **D4 — WebP derivatives (preview/thumbnail) stay out of the critical path.** The
  existing `recordGeneration` contract (pinned by `lib/__tests__/record-stores-once.test.ts`)
  is: pass `previewUrl`/`thumbnailUrl` (even `null`) and it is not re-derived; omit
  them and it calls `storeGeneratedImage` itself, synchronously, with no deadline.
  Moving the whole call pre-response would therefore also move that unbounded
  fetch-and-reupload into the critical path — a real regression risk on a path that
  has *already captured the buyer's payment* by this point (platform-kill-before-
  responding would strand a paid, generated, stored image behind a hung response).
  Fix: `generate-image/route.ts` now passes `previewUrl: null, thumbnailUrl: null`
  explicitly (the existing, already-tested "caller brought none, stays none" branch —
  no new code path inside `record.ts`), and a new small helper,
  `attachImageDerivatives`, is scheduled in `after()` to compute the WebP renditions
  and `UPDATE generated_images SET preview_url=..., thumbnail_url=...` once they're
  ready. `storeGeneratedImage` already skips re-uploading the original when the URL
  is already in our own store (`inOurBlob`), so this costs two small WebP uploads,
  not a re-upload of the original — the "images uploaded twice" complaint in REC-1's
  ticket text does not apply to the original image on this path.
- **D5 — `amount_paid_cents` is the buyer's total, not the artist's share.**
  `generation_payment_intents.total_micro` (micro-USDC, 1e6 = 1 USDC) is what the
  intent row already carries for this; `artist_amount_micro` (already selected) is
  the artist's cut only. `amountPaidCents = Math.round(total_micro / 10_000)`.
- **D6 — `transactionHash` is `tx_signature`, resolved per claim mode.** `authorized`
  mode: the raw signature `captureAndBroadcast` returns on a successful capture
  (`bs58`-encoded, same value the row's own `tx_signature` column gets). `prepaid`
  mode (legacy `status='confirmed'` path, still reachable through `claimForGeneration`):
  `tx_signature` is already on the intent row by the time it reaches `status='confirmed'`
  (set by whatever confirmed it before generation started), so it is read in the
  original intent SELECT alongside `total_micro` and carried through unless capture
  (authorized mode) produces a fresher one.
- **D7 — a recording failure never withholds the image.** `recordGeneration`'s
  internal try/catch is unchanged (still returns `null`/partial result rather than
  throwing); the route still answers 200 with the image whether or not the row
  landed. Added: when the record that failed carries payment info
  (`paymentIntentId` or `amountPaidCents` set), `record.ts` now also calls
  `notifyAdmins` (fire-and-forget) so a lost paid-generation row is alerted, not just
  `console.warn`'d into the void.

## Contract
`GenerationRecord` gains `paymentIntentId?: string | null`. `recordGeneration` returns
`{ generationId, imageId } | null`. New: `attachImageDerivatives(supabase, imageId,
imageUrl, userId, deadline?)` — best-effort, never throws.

`generations` gains `payment_intent_id uuid references generation_payment_intents(id)`
— **migration prepared, not applied** (`migrations/2026-10-09-generations-payment-intent-id.sql`);
a human runs it in the Supabase SQL editor before this deploys, same as every other
migration in this repo (per `generation_payment_intents.sql`'s own header, migrations
here are not auto-applied).

`POST /api/generate-image` response gains `imageId: string | null`.

## Acceptance Criteria (Given/When/Then)
- **AC1** Given a paid, logged-in generation that completes and records successfully,
  when the response is built, then it includes `imageId` equal to the
  `generated_images.id` just inserted, and `generations.payment_intent_id`,
  `transaction_hash`, `amount_paid_cents` are all non-null for that row.
- **AC2** Given the same, when the claim mode is `authorized`, then
  `transaction_hash` equals the signature `captureAndBroadcast` returned for this
  capture (not a redacted/truncated value).
- **AC3** Given `recordGeneration` fails (DB unreachable, insert error, or a thrown
  exception) on a generation that carries `paymentIntentId`/`amountPaidCents`, when
  the route finishes, then the HTTP response still carries the generated image
  (`imageUrl`, 200), `imageId` is `null`, and an admin alert was sent (`notifyAdmins`
  called) in addition to the `console.error` log.
- **AC4** Given `generated_images` insert fails after `generations` insert succeeds,
  when `recordGeneration` returns, then it still returns the `generationId` (not a
  total loss) with `imageId: null`, and the same admin alert fires.

## Test plan
New file `lib/__tests__/record-payment-link.test.ts` (unit, same fake-Supabase-chain
style as `record-stores-once.test.ts`):
- recordGeneration writes `payment_intent_id`/`transaction_hash`/`amount_paid_cents`
  onto the `generations` insert row when given.
- recordGeneration returns `{ generationId, imageId }` with `imageId` equal to the
  mocked `generated_images` insert id.
- recordGeneration returns `{ generationId, imageId: null }` (not `null`) when the
  `generated_images` insert errors, and the paid-alert path (`notifyAdmins`, mocked)
  fires only when `paymentIntentId`/`amountPaidCents` is set, not for a free record.
- `attachImageDerivatives` calls the mocked `storeGeneratedImage` and issues an
  `UPDATE` on `generated_images` with the returned preview/thumbnail URLs; never
  throws when the mocked store call rejects.

Existing `lib/__tests__/record-stores-once.test.ts`, `adult-content.test.ts`,
`draft-titles-private.test.ts`, `free-route-records-image.test.ts`: must stay green
unmodified — none of them depend on the old `string | null` return value.

No new test touches a live DB, payment rail, or paid provider; all run against the
existing fake-Supabase-chain mocks already used in this suite.

## Rollout / rollback
Rollout: apply the migration first (additive, nullable column, `IF NOT EXISTS` —
safe to run any time, including before this code deploys). Deploy code after.
Rollback: revert the code deploy; the column stays (harmless, nullable, unused) or a
human drops it later — never drop a column as part of an emergency rollback.
