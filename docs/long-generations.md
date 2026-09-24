# Generations that outlive the function

Design note, 2026-08-07. The status block below is the only part that
describes the code as it is; the rest is the reasoning and the state that
prompted the change. Status checked against the tree on 2026-09-24.

## Status, 2026-09-24

> **Applied.** Recommendation A: `app/api/generate-image/route.ts` exports
> `maxDuration = 300` and so does `app/api/x402/generate/route.ts`
> (`app/api/workflow/variables/route.ts` exports 30). The dependent budgets
> moved with it: `SOLANA_GENERATION_TIMEOUT_MS = 285_000` in the generate
> route, `SLOT_TTL_MS = 330_000` in `lib/generation/concurrency.ts`,
> `STALE_CLAIM_MS = 360_000` in `lib/payments/generation-redemption.ts`.
>
> **Cap coverage.** The in-process cap applies only when `paidUpfront`
> (Solana header or a consumed intent, route line `const paidUpfront =`).
> The EVM x402 `paymentEngine.settle` branch has no cap, but it cannot run:
> every non Solana `X-PAYMENT` request without an intent is answered 501
> before any settle or provider call (the route's guard
> `if (!intentId && !isSolanaPayment)`; Kev: no EVM billing, the code
> exists but is not enabled). Present, unreachable, not an open hole.
>
> **Superseded since this note was written.**
> - Authorise then capture is wired: the generate route imports
>   `captureAndBroadcast`, `voidAndFlush` and `sweepAndFlush` from
>   `lib/payments/settle.ts`, captures after the image is stored, voids on
>   provider failure, and schedules `sweepAndFlush` with `after()` on every
>   request.
> - The heartbeat is gone. `lib/payments/authorization.ts` anchors on
>   `consumed_at` and voids after `ABANDONED_AFTER_MS = 360_000`, derived
>   from the same budget ladder; `HEARTBEAT_GRACE_MS` no longer exists.
> - The generation row is written with `after(recordGeneration(...))` in the
>   generate route, so path 3 below (blob stored, row never lands) now
>   depends on `after()` surviving the function, which it does inside the
>   300 s budget.
> - `generation_jobs` is still untouched by any code.
>
> Raising `maxDuration` alone, which is what happened first, inverted the
> ordering this document warns about: the slot TTL (150s) and the stale-claim
> release (180s) both sat *below* the new platform budget, so a generation
> still running would lose its concurrency slot and have its payment claim
> released. Fixed in `35d5abb` (fix(generation): restore the budget ladder
> broken by raising maxDuration), the commit directly before `eacc044`, which
> recorded the first version of this note.

We were not near Vercel's limit. We were near a number we chose ourselves.

`app/api/generate-image/route.ts` set `maxDuration = 120`. Vercel's ceiling with
fluid compute (on by default) is **300s on Hobby and 800s on Pro/Enterprise**, with
a 1800s per-function beta above that — source: [Configuring Maximum Duration for
Vercel Functions](https://vercel.com/docs/functions/configuring-functions/duration),
doc last updated 2026-07-01, retrieved 2026-08-07. The default on every plan is
300s. `vercel.json` declares only `framework: nextjs` — no `functions` block, so
the 120 came entirely from the route export, and at the time no other route
in the repo exported `maxDuration` (see the status block for today).

The plan is **not determinable from the repo** (`.vercel/project.json` holds only
`orgId`/`projectId`). It only matters if we ever want more than 300s. Kev can
confirm under Settings → Functions.

## What is actually tight

| budget | value | where |
|---|---|---|
| platform kill | 120s | `app/api/generate-image/route.ts:36` |
| in-process cap on the provider call | 90s | same file, `SOLANA_GENERATION_TIMEOUT_MS`, line 38 |
| …but only when `paidUpfront` | Solana x402 or intent only | line 655 |
| WaveSpeed adapter's own poll deadline | 240s | `backend/services/wavespeed-image-generation.ts:26` |
| concurrency slot TTL | 150s | `lib/generation/concurrency.ts:25` |
| stale-claim rescue | 180s | `lib/payments/generation-redemption.ts:23` |
| authorisation heartbeat grace | 45s | `lib/payments/authorization.ts:50` |

Measured 2026-08-06, real calls:

| provider / model | 1K | 2K | 4K |
|---|---|---|---|
| WaveSpeed nano-banana-pro | 73.1s | 78.1s | 77.0s |
| Gemini direct | 19.2s | 28.5s | 38.8s |
| AceData nano-banana-pro:official | 28.1s | 37.2s | 50.4s |
| AceData gpt-image-2 @3840×2160 | — | — | 63.1s |

**WaveSpeed 2K at 78.1s against a 90s cap is 12s of headroom — 13%, off one
sample.** And the provider call is not alone in the 120s: moderation, the Gemini
prompt rewrite, `storeReferenceImages` (awaited on the critical path, route.ts:895)
and a blob upload of up to ~7 MB all come out of the same budget. Nothing else in
the table is close; everything under 60s is comfortable.

The number that will break first is not in the table yet. `lib/generation/routing.ts`
returns a **fallback chain**, and a first-choice miss plus a fallback is additive:
AceData 4K (50.4s) failing into WaveSpeed (77.0s) is 127.4s — over the platform
kill before the picture is even downloaded. That wiring is in flight right now.

## What happens today when it does not finish

Three paths, three different outcomes.

**1. Intent or Solana x402 (`paidUpfront === true`).** The 90s `withTimeout` rejects
into the catch-all, `releaseIfConsumed()` gives the intent back, the slot is freed
in `finally`, and the user gets a 500 with a real message ("Image generation timed
out after payment…"). The buyer is not charged twice. For the Solana *header* path
the USDC transfer is already confirmed on chain and there is no refund — that
buyer paid and got an error. The image: WaveSpeed finishes the job seconds later
and keeps the output at a URL we can no longer name, because the prediction id
lived only in the adapter's stack frame. **Orphaned beyond reach, not recoverable.**

**2. EVM x402 exact/upto — the bad one.** `paidUpfront` is false there, so **there
is no in-process cap at all**, even though `paymentEngine.settle()` has already
moved the money through the facilitator before generation starts. The adapter is
willing to poll for 240s; Vercel kills the function at 120s. The client gets a
platform 504 with no JSON body, which `components/enki-shell/generation.ts:79`
renders as `Generation failed (504)`. Nothing is released, nothing is recorded, no
server-side trace survives. Charged, no image, no explanation.

**3. Killed after the blob upload.** The image is in blob storage with a public URL,
and the `generations` row never lands: `after()` "will run for the platform's
default or configured max duration of your route"
([Next.js docs](https://nextjs.org/docs/app/api-reference/functions/after)) — a kill
takes the callback with it. A paid image exists, unreferenced, billed to us forever.
Genuinely orphaned rather than lost.

**Was true on 2026-08-07, no longer (see the status block):** the
authorise-then-capture flow was **built and unwired**. `lib/payments/settle.ts`
exports `captureAndBroadcast`, `voidAndFlush` and `sweepAndFlush`; a repo-wide grep
finds **no caller for any of the three**. Only `/api/payments/generation/submit`
calls `storeAuthorization`, and no UI code calls that route either. The columns are
live (`heartbeat_at`, `captured_at`, `voided_at`, `nonce_account`, `void_reason` all
probed on `generation_payment_intents`). So the flow cannot strand anything yet —
but wired without its heartbeat driver, every authorisation goes stale after 45s
while the generation is still running, and the sweeper that would clean it up is
never invoked.

## Options

**A — raise `maxDuration`.** One number. Covers every measured combination
including a two-provider fallback chain. Does not fix 80 seconds of silent spinner,
does not survive a dropped connection, and Vercel's own doc warns that HTTP/1.1
intermediaries may close a long idle response and recommends streaming heartbeat
data. Cost is close to zero: with fluid compute "active CPU billing applies while
your code is executing, and pauses while your function is waiting on I/O", and a
function sitting on a provider poll is idle I/O.

**B — provider async + callback.** What exists today: the submit half, and nothing
else. The WaveSpeed adapter submits and polls in-process; **there is no AceData
adapter in `backend/services/` at all** — AceData is DB rows
(`migrations/2026-08-07-route-priority-acedata.sql`), a routing entry, and a free
402-quote health probe (`lib/generation/provider-health.ts:160`). Building B means:
a public webhook route; HMAC-SHA256 verification (WaveSpeed signs
`{webhook-id}.{webhook-timestamp}.{raw_body}` into a `webhook-signature: v3,<hex>`
header, secret `whsec_`-prefixed, 300s max age, [docs](https://wavespeed.ai/docs/verify-webhooks));
idempotency, because the callback retries three times with backoff; a job row; and a
way for the client to learn the result. Gemini direct has no callback, so the
synchronous path stays — **two code paths forever**. It unbounds the generation and
fixes nothing else.

**C — client-side polling.** Not a standalone option, and listing it as one would be
wrong: the server work still has to outlive the request, and on Vercel it does not.
C is the client half of B or D.

**D — a queue.** `generation_jobs` already exists live (status, attempt_count,
locked_by/locked_until, resulted_in_generation_id) and **no code touches it**. There
is no cron on this deployment — Vercel Cron's 1-minute floor would add more latency
than the generation costs. So D means an external worker (`backend/**`, Marvel/Mantle
territory) or opportunistic sweeps like `generation_slots` uses. Highest cost; it is
where retries and fallback chains eventually want to live.

## Recommendation: A, with the cap made honest

Raise `maxDuration` to **300** — the default and the ceiling on every plan, so it is
safe without knowing which one we are on — and fix the cap that is supposed to
protect payments:

- `SOLANA_GENERATION_TIMEOUT_MS` 90 → **285**, i.e. the platform kill minus the
  headroom the tail of the request actually needs. Measured 2026-08-07 on the
  largest real output (3840x2160, 13.92 MB): sharp derivatives cost 250ms; the
  remaining ~15s covers moving ~14 MB down from the provider and ~14 MB up into
  blob storage, which cannot be measured from a dev machine. It sits ABOVE the
  WaveSpeed adapter's own 240s `MAX_POLL_MS`, so that adapter still gives up
  first and returns its own error rather than being cut off mid-poll.
- Apply that cap on **every paid path**, not just `paidUpfront`. The EVM x402 branch
  settles and then generates with no cap at all; it is the only place money can be
  taken with no release path, and it is a one-line condition.
- `SLOT_TTL_MS` 150 → **330** and `STALE_CLAIM_MS` 180 → **360**, both of which exist
  only to sit above the kill.

Ordering is the whole point and must hold: **285 (in-process) < 300 (platform) < 330
(slot) < 360 (stale claim)**. A Vercel kill skips `finally`, so the intent release has
to fire from inside the process — that is why the in-process cap exists and why it
must stay strictly below `maxDuration`. 60s of headroom inside the 300 covers the
rewrite, the upload and the record, and absorbs a 127s two-provider fallback chain.

Five numbers, one condition, no new surface, one clean revert. B and D cost a public
endpoint, signature verification, an idempotency story and a permanent second code
path to solve a problem a number already solves. Revisit when one call genuinely
exceeds ~285s — video, or batch `n > 1`.

Explicitly not fixed: 80 seconds of blank spinner. That is a UI change (stream
progress, which also keeps the connection warm), and it should be its own commit.

## How payment behaves under each option

The invariant is `lib/payments/authorization.ts`: *ordered means delivered* —
capture only after the image is durably stored, void otherwise, and a conditional
UPDATE guarantees a race has a loser rather than two winners.

- **A.** Unchanged and correct, *provided* the in-process cap stays strictly below
  `maxDuration` — otherwise a killed function releases nothing and the intent waits
  out `STALE_CLAIM_MS`. Every timeout releases the intent, so the buyer retries
  without paying again. The EVM x402 gap above is not a consequence of A; it is a
  hole that exists now and that A is the natural moment to close.
- **B / D.** The authorisation outlives the request, which is exactly what the
  heartbeat was designed for and exactly what nothing currently drives. A worker
  must `beat()` while the job is open, void on provider failure, capture only after
  durable storage, and something must actually call `sweepAndFlush`. Built without
  that driver, `HEARTBEAT_GRACE_MS = 45s` means every async job is voided *while
  succeeding* — the image handed over unpaid. An async design that does not ship the
  heartbeat driver in the same change is worse than the synchronous one.
- **C.** n/a.

One thing no option fixes: on the x402-header flows the money moves **before**
generation, so a timeout is never free. Only authorise-then-capture makes it free,
and finishing that — wiring `captureAndBroadcast` / `voidAndFlush` / `sweepAndFlush`
into the generate route — is worth more than any of the four options here. It is the
follow-up this note recommends after A.
