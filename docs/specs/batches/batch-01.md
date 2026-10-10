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

## Verdict
BAN-8 (#166) is **not ready to merge**. Sending back to Agent A: the step-up gate must be
enforced before the server returns a co-signable transaction (i.e. before/at `/build`,
not only at `/submit`), while still achieving single-use + request-id binding (mint the
request id at build time, before `partialSign`, and consume the token there). MFA-1
(#165) is unaffected by this finding and can proceed independently once a human reads
back the consumed-token-store migration.

## Subagents used
- Agent A (task agent): MFA-1 + BAN-8 implementation.
- Independent reviewer (read-only, diff + spec only, no prior context from Agent A's
  session): found the regression above.

## Next
Agent A revising BAN-8 per the verdict above. Not blocked otherwise.
