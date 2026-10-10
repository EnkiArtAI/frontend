# Batch 01: MFA-1 + BAN-8

Baseline: main @ 470739a   PRs: #165 (MFA-1), #166 (BAN-8, stacked on #165)

## Done / Remaining (per task)
MFA-1: jti + DB-backed consumed-token store — implemented, CI green (build/lint/tests/typecheck
all pass on both PRs; 3 unrelated Vercel preview checks fail for pre-existing org/plan reasons).
BAN-8: request-id-bound single-use step-up + owner email — implemented, CI green, but see
Independent review below: **not actually ready**, a confirmed regression must be fixed first.

## Independent review (money/funds path, per section 4B.4) — 2026-10-10

**Finding 1 — CONFIRMED security regression.** BAN-8 moved the withdraw step-up check from
`/api/wallet/withdraw/build` (destination-bound) to `/api/wallet/withdraw/submit`
(request-id-bound), deleting the old comment explaining why the check lived at `/build`.
The reviewer traced the actual code path: `lib/payments/withdraw.ts:262`
(`buildWithdrawTx`) co-signs with the fee payer *inside* `/build`, before any step-up
check now exists there. Once the client's wallet signs that output, the transaction is
fully valid and broadcastable to **any** Solana RPC, entirely bypassing `/submit` (and
therefore the step-up check that now lives only there). `walletUnlocked`
(`app/api/auth/wallet/jwt/route.ts:85-87`), which the task agent cited as an independent
gate, only covers the CDP JWT-minting bridge — externally-signed wallets
(`adapterSign` in `components/settings/SendUsdcPanel.tsx:86-92`) never touch that route;
signing is 100% client-side. Net effect: for any non-CDP wallet with a factor enrolled,
there is currently no server chokepoint enforcing step-up before funds can move — a
modified client or direct broadcast skips MFA entirely. This did not exist before BAN-8;
the old `/build`-side check sat before the irreversible co-sign and closed this path.

**Finding 2 — CONFIRMED ship-order hazard** (the task agent already flagged this one
correctly). `components/settings/SendUsdcPanel.tsx:110` still wraps `/build` with the
step-up dialog; `/submit` at line 130 sends no step-up header at all. Merging #166 as-is
breaks every real withdrawal (401) for any user with a factor enrolled, until the
frontend PR (already filed as task_4eda0378) lands. This is a sequencing problem on top
of Finding 1, not a separate root cause.

**Adversarial pass (no further issues):** replay-across-requests, consumed-store
fail-closed, scope-string collision/injection, banned-user funds-door-stays-open, and the
mutation evidence for the unit-level checks all held up.

## Revision (2026-10-10) — fix delivered, one scope reduction to flag

Agent A moved the step-up check back to `app/api/wallet/withdraw/build/route.ts`,
running right after `checkWithdrawRequest` and before `buildWithdrawTx` (which does the
fee-payer co-sign via `partialSign`). A blocked step-up now means the co-signed
transaction is never created, so there is nothing for a client to sign-and-broadcast
around the check — the confirmed bypass is closed. `/submit` no longer checks step-up
(nothing left to check there); it keeps the owner-confirmation email.

**Scope reduction, deliberately flagged, not silent:** the fix reverted the step-up scope
to the original **destination-bound** shape (`withdraw:<base58 address>`), not the
**request-id-bound** shape BAN-8 originally asked for. Reason: true request-id binding
at `/build` hits a chicken-and-egg problem — the withdrawal row's id doesn't exist before
the call that would need to gate on it; solving that needs either persisting unsigned tx
bytes for a later resume (a second migration) or a speculative row insert, neither
attempted here. Single-use is still achieved via MFA-1's generic consumed-token store
(any `withdraw:*` token's `jti` is consumed once, so a destination-bound token can't be
replayed) — this closes the regression and the original replay concern without request-id
binding. **Net effect: BAN-8 now ships "destination-bound, single-use" rather than the
originally-specced "request-id-bound, single-use."** Documented in
`docs/specs/BAN-8.md` ("Decisions" §2, "Revision history"). Worth the human's attention
when reviewing #166 — this is a real, reasoned tradeoff, not a downgrade to avoid work,
but it is a smaller delivery than the ticket asked for.

**Bonus finding:** the frontend follow-up task filed earlier (task_4eda0378, "move
withdraw step-up UI wrap from /build to /submit") is now stale and has been dismissed —
`SendUsdcPanel.tsx` already wraps `/build` with the correct scope, since that's exactly
where the check reverted to. No frontend PR needed after all.

Red test: `lib/__tests__/withdraw-stepup.test.ts`, the "DECISIVE" test proving an
externally-signed wallet can never obtain a co-signed transaction from `/build` without a
valid, unconsumed, correctly-scoped step-up token. Red: CI run 38009447541 (4 failures,
all in this file, 207 other files/2311 tests green). Green: runs 38009932654 + 38009935974
(build/lint/tests/typecheck all pass). Mutation check was in progress as of this report;
coordinator will record the result once it lands.

## Subagents used
- Agent A (task agent): MFA-1 + BAN-8 implementation and revision.
- Independent reviewer (read-only, diff + spec only, no prior context from Agent A's
  session): found the original regression.

## Next
Waiting on Agent A's mutation-check confirmation for the revised fix. MFA-1 (#165)
unaffected throughout, still green, ready for human merge once the consumed-token-store
migration is applied and read back.
