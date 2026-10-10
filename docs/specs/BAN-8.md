# BAN-8 · Step up before withdraw, single use
Source: https://app.clickup.com/t/86cbk4ffx
Status: In progress — revised 2026-10-10 after an independent review found a
confirmed regression in the first version of this PR. See "Revision history"
at the bottom.

## Done / Remaining

| Item | Status |
| --- | --- |
| Withdraw step-up gate exists, at `/build`, before the fee-payer co-sign | Done (pre-existing; this PR keeps it there — see Revision history for why it was moved away and back) |
| Export unlock + notice mail | Done (pre-existing, untouched) |
| Single use (MFA-1's store) | This PR |
| Owner mail on every confirmed withdrawal | This PR |
| Password re-check / TOTP fallback UX for users without a passkey | **Not done — frontend, flagged below.** `components/StepUpProvider.tsx`'s `guarded()`/`withStepUp()` already offers whichever factor `enrolledFactors` returns (passkey, totp, email); MFA-5 (TOTP/email) already shipped. A user with *no* factor at all is unaffected either way: `requireStepUp` for `withdraw:*` has never been `mandatory`. |
| Never enroll CDP wallet MFA | Not touched — no code here mints or stores factor state for a CDP wallet; out of scope. |
| `SendUsdcPanel.tsx` frontend change | **Not needed any more.** The gate is back at the same call site (`/build`) with the same scope shape (`withdraw:<destination>`) the frontend already sends a token for. See Revision history. |

## Problem

Today (`app/api/wallet/withdraw/build/route.ts`, before this PR):
```ts
const blocked = await requireStepUp(req, who.userId, `withdraw:${to!.toBase58()}`);
```
The token is bound to `(userId, scope)` only — nothing stopped it being
presented to `/build` again and again inside its 5 minute TTL, each time
authorizing a fresh, independently fee-payer-co-signed, independently
broadcastable transaction to the same destination. MFA-1 fixed exactly this
with a generic single-use mechanism (any `X-StepUp-Token` for a scope
starting `export` or `withdraw:` is claimed, once, in
`consumed_stepup_tokens`); this task wires that into the withdraw path.

## Scope

**In scope:**
- Keep (restore, see Revision history) the step-up check at `/build`, before
  `buildWithdrawTx` co-signs with the fee payer — unchanged scope shape,
  `withdraw:<destination address>`. MFA-1's generic money-scope handling in
  `requireStepUp` already makes this single-use with zero extra code here.
- `lib/payments/withdraw.ts`: `notifyWithdrawalConfirmed` — mails the owner
  once a withdrawal's status reaches `confirmed`, from `/submit`. Best
  effort (never unwinds a withdrawal that already moved); same "verified
  password-account email" lookup `lib/webauthn.ts`'s existing export notice
  already uses.
- `lib/__tests__/withdraw-stepup.test.ts`: tests that `/build` cannot return
  a co-signed transaction without a valid, unconsumed token for its own
  scope (the decisive test — see Acceptance criteria AC-1), that the same
  token cannot authorize a second build, fail-closed on a store error, the
  owner mail, and the funds door staying open for a banned user.

**Out of scope (flagged, not done):**
- Request-id-bound scopes. Tried in the first version of this PR (checked
  at `/submit`, scope `withdraw:<row id>`); reverted — see Revision history.
  A genuinely request-id-bound check back at `/build` is possible but needs
  a second migration (persisting the UNSIGNED transaction's bytes, not just
  its hash, so a later call can rehydrate and sign it instead of rebuilding
  with a fresh blockhash) and a client-side body-shape change to pass the id
  back on retry. Not pursued: destination-binding + MFA-1's single-use
  closes the actual confirmed regression and the original replay concern
  without either. Worth reconsidering as a future hardening if the team
  wants per-call precision tighter than per-destination.
- Password re-check / "Never enroll CDP wallet MFA" — see Done/Remaining;
  no code change identified as necessary for either.
- A `cron` or ad hoc cleanup of old `consumed_stepup_tokens` rows — MFA-1's
  concern, not repeated here.

## Decisions

1. **Build-time gate, not submit-time — restored after a confirmed
   regression.** See Revision history for the full incident. Summary: the
   gate must sit before `buildWithdrawTx`'s `tx.partialSign(feePayer)`
   (`lib/payments/withdraw.ts:262`, inside `buildWithdrawTx`), because once
   that runs and the client's own wallet adds its signature, the bytes are a
   complete, broadcastable Solana transaction — nothing server-side needs to
   see it again. A check that lives only at `/submit` cannot stop a client
   that never calls `/submit`. `walletUnlocked` does not cover this for an
   externally-signed wallet (`adapterSign` in `SendUsdcPanel.tsx`, 100%
   client-side, never touches the CDP JWT bridge that `walletUnlocked`
   gates) — that reasoning, made when this PR first moved the check, was
   wrong for the common (non-CDP) case.
2. **Destination-bound, not request-id-bound.** Request-id binding was the
   original ask (MFA-1/BAN-8 task text) as a way to express "this token
   authorizes exactly one transfer, never a different one." Single-use
   (MFA-1) already gives that: whatever the scope's shape, a `jti` is
   claimed once, full stop. The only thing request-id binding would add on
   top is preventing ONE token from being valid for two DIFFERENT builds to
   the SAME destination that happen to both be pending at once — a
   narrower case single-use already closes at the point that matters (a
   consumed token is consumed; a second build still needs its own fresh
   token, bound to the same destination, which still requires the user to
   approve it). Binding to a row id specifically would require minting that
   row before the very call it would gate — a genuine chicken-and-egg
   (`/build` is what creates the row) that is only solvable by either
   inserting the row speculatively before authorization (and cleaning up on
   refusal) or persisting the unsigned transaction for a later resume (a
   second migration). Neither is justified by what's actually missing once
   single-use is in place. **Recommendation: destination-bound + single-use
   is sufficient; not escalating to request-id-bound.** Flagging this
   explicitly since it is a narrower property than the original task text
   asked for, in case the team wants the tighter guarantee enough to justify
   the extra migration.
3. **Mandatory or not.** Left exactly as before: `requireStepUp` for
   `withdraw:*` is still called without `{ mandatory: true }`. A banned or
   factor-less user must still be able to withdraw (hard rule: the funds
   door never locks). Out of scope per the coordinator's instruction not to
   touch mandatory wiring.
4. **Owner-email lookup for the confirmation mail.** Reuses the exact
   `password_credentials.email` + `email_verified_at` lookup
   `afterStepUp`'s export notice already uses. The gap (wallet-only owner,
   no password, gets no mail) is the same gap the export notice already has
   today — not introduced here.

## Contract

- `lib/webauthn.ts` `SCOPE`: `withdraw:` branch stays the base58 Solana
  address shape (`withdraw:[1-9A-HJ-NP-Za-km-z]{32,44}`) — unchanged from
  before this task (the UUID-shaped version from the reverted submit-time
  design is gone).
- `app/api/wallet/withdraw/build/route.ts`: `requireStepUp(req, who.userId,
  \`withdraw:${to.toBase58()}\`)` runs after `checkWithdrawRequest`, before
  the rate-limit read and before `buildWithdrawTx` (and therefore before
  its `partialSign`). A 401/403/503 here means `buildWithdrawTx` is never
  called — no fee-payer signature exists for the client to broadcast.
- `app/api/wallet/withdraw/submit/route.ts`: no step-up check (reverted). On
  a `confirmed` result, `notifyWithdrawalConfirmed` fires (best effort,
  never changes the response).
- `lib/payments/withdraw.ts`: `notifyWithdrawalConfirmed(supabase, userId,
  { amountMicro, to, signature }): Promise<void>`. Never throws.

## Acceptance criteria

- **AC-1 (decisive — no co-signed transaction without step-up):** Given a
  user with a factor enrolled, When `/build` is called with no token, or
  with a token for a different destination, Then it is refused (401) and
  `buildWithdrawTx` (the fee-payer co-sign) is never invoked. **Pass** —
  this is the specific property the confirmed regression broke and the one
  the independent review asked be proven directly.
- **AC-2 (single-use):** Given a token already used to build once, When the
  same token is presented again, Then `/build` refuses it and does not
  co-sign a second time. **Pass.**
- **AC-3 (consumed-store failure fails closed):** Given the
  `consumed_stepup_tokens` insert fails for a reason other than a duplicate
  key, When `/build` is called with an otherwise-valid token, Then it
  answers 503 and never co-signs. **Pass.**
- **AC-4 (owner mail once per confirmed withdrawal):** Given a withdrawal
  that reaches `confirmed`, When `/submit` returns its signature, Then
  exactly one mail was sent to the owner's verified email. **Pass.**
- **AC-5 (funds door open for a banned user):** Given a banned session, When
  they build (and, once past step-up, submit) a withdrawal, Then it
  succeeds exactly as for an unbanned user — a ban never adds a step-up
  requirement beyond what an unbanned user already faces. **Pass.**

## Test plan

| AC | Test | File |
| --- | --- | --- |
| AC-1 | "DECISIVE: an externally-signed wallet can never obtain a co-signed transaction from /build without a valid, unconsumed step-up token..." | `lib/__tests__/withdraw-stepup.test.ts` |
| AC-2 | "a token is single-use: the SAME approval cannot authorize a second build to the same destination" | same |
| AC-3 | "fails closed when the consumed-token store errors, never co-signing" | same |
| AC-4 | "mails the owner once the transfer confirms" | same |
| AC-5 | "stays open for a banned user without a factor, and still gates one with a factor exactly like an unbanned user" / "stays open for a banned user" (submit) | same |

## Rollout and rollback

- **Frontend:** no change needed. `SendUsdcPanel.tsx` already wraps `/build`
  with `guarded(\`withdraw:${toTrimmed}\`, ...)` — exactly the scope and
  call site this revised PR uses. The frontend follow-up task filed under
  the first version of this PR (task_4eda0378, "Move withdraw step-up UI
  wrap from /build to /submit") is now stale and should be dismissed.
- **Human step required before merge:** none beyond MFA-1's migration
  (reused, no new table). Re-run the PostgREST read-back from MFA-1's
  rollout note if it has not happened yet.
- **Order:** stacks on `feat/mfa-1-single-use-stepup`; retarget to `main`
  once that merges.
- **Rollback:** `git revert`. No migration of its own.

## Revision history

**2026-10-09, first version:** moved the step-up check from `/build`
(destination-bound) to `/submit` (bound to the withdrawal row's own id), on
the reasoning that `/build` "builds nothing irreversible" and that CDP
wallet signing was independently gated by `walletUnlocked`.

**2026-10-10, independent review (CONFIRMED regression):** `buildWithdrawTx`
(`lib/payments/withdraw.ts:262`) co-signs with the fee payer INSIDE `/build`
— so by the time execution would reach a check at `/submit`, the server has
already handed the client a transaction that needs only the user's own
wallet signature to become fully valid and broadcastable to any Solana RPC,
with no further involvement from Enki at all. The `walletUnlocked` reasoning
covers the CDP (custodial) bridge only; `SendUsdcPanel.tsx`'s `adapterSign`
path (externally-signed wallets — Phantom etc., the common case: "16
external Solana wallets" per `BAN.md`) signs 100% client-side and never
touches that bridge. Net effect of the first version: a non-CDP wallet with
a factor enrolled had no server chokepoint enforcing step-up before funds
could move. This PR reverts the relocation: the gate is back at `/build`,
before the co-sign, with its original destination-bound scope. Single-use
(MFA-1, unaffected by this revision) still applies, closing the original
replay concern the request-id design was reaching for, without the
chicken-and-egg problem that design has at `/build` (the row id, were it
used, cannot exist before the very call that would gate on it).
