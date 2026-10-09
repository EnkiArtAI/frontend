# BAN-8 · Step up before withdraw, bound to the request, single use
Source: https://app.clickup.com/t/86cbk4ffx
Status: In progress

## Done / Remaining

| Item | Status |
| --- | --- |
| Withdraw step-up gate exists | Done (pre-existing, this PR relocates and rebinds it) |
| Export unlock + notice mail | Done (pre-existing, untouched) |
| Token bound to a server-issued request id, not the destination | This PR |
| Consumed once (MFA-1's single-use store) | This PR |
| Owner mail on every confirmed withdrawal | This PR |
| Password re-check / TOTP fallback UX for users without a passkey | **Not done — frontend, flagged below.** `components/StepUpProvider.tsx`'s `guarded()`/`withStepUp()` already offers whichever factor `enrolledFactors` returns (passkey, totp, email); MFA-5 (TOTP/email) already shipped, so no new UX is needed for users *with* a factor. A user with *no* factor at all is unaffected either way: `requireStepUp` for `withdraw:*` has never been `mandatory`, so this PR does not change who can withdraw without a factor. |
| Never enroll CDP wallet MFA | Not touched — no code here mints or stores factor state for a CDP wallet; out of scope for a step-up-binding change. |

## Problem

Today (`app/api/wallet/withdraw/build/route.ts:63`, before this PR):
```ts
const blocked = await requireStepUp(req, who.userId, `withdraw:${to!.toBase58()}`);
```
The step-up scope is bound to the **destination address**, not to the specific
withdrawal request. Before MFA-1, a token for `withdraw:<address>` was also
reusable for its whole 5 minute TTL (no single-use at all). After MFA-1 alone
(single-use per scope string), it is still bound to the destination, not the
request: one step-up could be claimed for `withdraw:<address>`, then the
SAME scope string re-requested and re-approved for a second, third, fourth
`/build` call to the same address inside the window — each producing its own
fee-payer-co-signed, independently submittable transaction, all authorized
by scopes that only ever differ from each other by nothing (same string).
Binding the scope to a **server-issued request id** (one `/build` call = one
id = one token = one withdrawal, ever) closes that, and is also the natural
fit for MFA-1's single-use mechanism: a request id can only ever mean one
specific transfer.

`app/api/wallet/withdraw/submit/route.ts` has no step-up check at all today.

## Scope

**In scope:**
- Move the step-up check from `/build` to `/submit`, scope
  `withdraw:${requestId}` (the withdrawal row's own `id`, already returned by
  `/build` as `requestId` and already required, UUID-validated, in `/submit`'s
  own body). `/build` builds nothing irreversible — its own doc comment says
  "Nothing moves here" — so moving the authorization check to the point that
  actually broadcasts is not a weaker gate for the external-wallet case (the
  wallet signature is the user's own, unconditionally theirs to give), and is
  not a weaker gate for the custodial (CDP) case either: minting a CDP wallet
  signing JWT already requires its own, independent `walletUnlocked` step-up
  (`app/api/auth/wallet/jwt/route.ts`), so a session that never passed ANY
  step-up cannot get CDP to sign a withdrawal regardless of what `/build` or
  `/submit` check. See Decisions for the full reasoning and the one thing
  this changes that a human should confirm.
- `SCOPE` regex (`lib/webauthn.ts`): the `withdraw:` branch changes from a
  base58 Solana address shape to a UUID shape (the request id).
- `lib/payments/withdraw.ts`: `notifyWithdrawalConfirmed` — mails the owner
  once a withdrawal's status reaches `confirmed`. Best effort (never unwinds
  a withdrawal that already moved); same "verified password-account email"
  lookup `lib/webauthn.ts`'s existing export notice already uses.
- Rewrite `lib/__tests__/withdraw-stepup.test.ts` for the new call site (it
  tested `/build`'s now-removed check); add the request-id-binding and
  single-use-replay tests at `/submit`.

**Out of scope (flagged, not done):**
- **`components/settings/SendUsdcPanel.tsx`** currently wraps the `/build`
  call with `guarded(\`withdraw:${toTrimmed}\`, ...)`. After this PR, that
  wrap does nothing useful (the server no longer checks step-up at `/build`)
  and `/submit` will refuse (401) anyone with a factor enrolled, because the
  client never sends a token there. **This backend PR alone breaks the live
  withdraw UI for every user who has a factor enrolled, the moment it
  merges.** Per `CONTRIBUTING.md` §3 ("a backend change and a UI change are
  two PRs, even when the feature needs both") and the Frontend/CODEOWNERS
  split (`components/**` is Frontend-owned), the fix belongs in a separate
  PR, not bundled here. It is a small, mechanical change — move the
  `guarded(...)` wrap from around the `/build` `post()` call to around the
  `/submit` `post()` call, scope `withdraw:${built.requestId}` instead of
  `withdraw:${toTrimmed}` — `withStepUp()`'s generic 401-then-retry shape
  needs no other change. **A human must sequence the merge of that PR with
  this one (same release, or this one held until the UI PR is ready) or
  withdrawals break for real users.** Flagged to the coordinator; not
  guessed into this PR.
- Password re-check / "Never enroll CDP wallet MFA" — see Done/Remaining;
  no code change identified as necessary for either.
- A `cron` or ad hoc cleanup of old `consumed_stepup_tokens` rows — MFA-1's
  concern, not repeated here.

## Decisions

1. **Build-time gate vs. submit-time gate.** The pre-existing code comment at
   `build/route.ts:59-62` argued the gate belongs at `/build`, "not at
   /submit", because after the wallet signs, "anyone can broadcast it
   without /submit". That is true in general, but the request-id binding
   this task needs cannot exist before `/build` creates the row (the id IS
   the row's primary key) — so keeping the check at `/build` would mean
   either (a) minting the row before validating anything, just to get an id
   to bind a token to, or (b) keeping the OLD destination-bound check at
   `/build` as well as a NEW request-id-bound one somewhere else, i.e. two
   separate human confirmations per withdrawal. Tracing the actual bypass the
   old comment worried about: it matters only for a CDP (custodial) wallet,
   where "the wallet" signs via our own server-side bridge, not the user's
   private key — and that bridge already requires `walletUnlocked`
   (`app/api/auth/wallet/jwt/route.ts`), itself gated by its OWN step-up
   (scope `wallet`, untouched by this task). A session that never stepped up
   cannot get a CDP signature at all, regardless of where `/build` or
   `/submit` check anything. For an externally-signed wallet, the signature
   is the user's own act — our check existing at `/build` was never what
   stopped them from assembling and broadcasting their own signed transfer
   outside Enki entirely; it only ever gated OUR audit trail and rate limit,
   which `/build`'s row-insert + `/submit`'s claim-once update still provide
   either way. **Recommendation: proceed with the submit-time gate** (this
   PR). Flagging for a human sanity check anyway, since it reverses a
   previous engineer's explicit, written security call on a money path —
   see "Decisions needed" in the final report.
2. **Mandatory or not.** Left exactly as before: `requireStepUp` for
   `withdraw:*` is still called without `{ mandatory: true }`. A banned or
   factor-less user must still be able to withdraw (hard rule: the funds
   door never locks). Changing this is MFA.md's "withdraw: mandatory, enroll
   first" decision, explicitly out of scope per the coordinator's
   instruction not to touch mandatory wiring.
3. **Owner-email lookup for the confirmation mail.** Reuses the exact
   `password_credentials.email` + `email_verified_at` lookup
   `afterStepUp`'s export notice already uses, rather than inventing a
   broader one that also covers a confirmed email MFA factor on a wallet-only
   account. Keeps this PR's blast radius to "add one more call site of an
   existing, tested pattern" instead of refactoring that pattern. The gap
   (wallet-only owner, no password, gets no mail) is the same gap the export
   notice already has today — not introduced here, and flagged as a
   follow-up, not blocking.

## Contract

- `lib/webauthn.ts` `SCOPE`: `withdraw:` branch becomes
  `withdraw:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`
  (lowercase UUID, matching Postgres `gen_random_uuid()`'s own casing).
- `app/api/wallet/withdraw/build/route.ts`: no step-up call. Behavior
  otherwise unchanged (validation, rate limit, build, insert, response
  shape all identical).
- `app/api/wallet/withdraw/submit/route.ts`: `requireStepUp(req, who.userId,
  \`withdraw:${requestId}\`)` runs after the row is found, owned by the
  caller, `pending`, and not expired — before the row is claimed
  (`status: "submitted"`) or anything is broadcast. A 401 here changes
  nothing in the database (the row stays `pending`, retryable with a fresh
  token). On a `confirmed` result, `notifyWithdrawalConfirmed` fires (best
  effort; never changes the response).
- `lib/payments/withdraw.ts`: new `notifyWithdrawalConfirmed(supabase,
  userId, { amountMicro, to, signature }): Promise<void>`. Never throws.

## Acceptance criteria

- **AC-1 (replayed token refused within TTL):** Given a confirmed-pending
  withdrawal and a step-up token scoped to its request id, When `/submit` is
  called twice with the same token (e.g. a retried submit after a client
  glitch), Then the second call is refused 401, not re-authorized by the
  same approval. **Pass.**
- **AC-2 (token for request A cannot authorize request B):** Given two
  withdrawal rows A and B for the same user, When a token scoped to
  `withdraw:<A>` is presented to `/submit` for request B, Then it is
  refused 401. **Pass.**
- **AC-3 (consumed-store failure fails closed):** inherited from MFA-1's
  `requireStepUp` — covered there, exercised again here against the
  `/submit` call site specifically. **Pass.**
- **AC-4 (owner mail once per confirmed withdrawal):** Given a withdrawal
  that reaches `confirmed`, When `/submit` returns its signature, Then
  exactly one mail was sent to the owner's verified email. **Pass.**
- **AC-5 (funds door open for a banned user):** Given a banned session with
  a Solana wallet and no step-up factor enrolled, When they build and submit
  a withdrawal, Then it succeeds exactly as for an unbanned user — a ban
  never adds a step-up requirement beyond what an unbanned user already
  faces. **Pass.**

## Test plan

| AC | Test | File |
| --- | --- | --- |
| AC-1, AC-2 | "a token for one request cannot authorize another, and cannot be replayed" | `lib/__tests__/withdraw-stepup.test.ts` (rewritten) |
| AC-3 | "fails closed when the consumed-token store errors" | same |
| AC-4 | "mails the owner once the transfer confirms" | same |
| AC-5 | "a banned user still withdraws without a factor" | same |

## Rollout and rollback

- **Must ship with (separate PR, human-sequenced):** the `SendUsdcPanel.tsx`
  change described under Scope/Out-of-scope. Holding this PR's merge (or
  merging both in the same release window) is a human call, not this
  agent's to make.
- **Human step required before merge:** none beyond MFA-1's migration
  (this PR reuses `consumed_stepup_tokens`, adds no new table). Re-run the
  PostgREST read-back from MFA-1's rollout note if it has not happened yet.
- **Order:** stacks on `feat/mfa-1-single-use-stepup`; retarget to `main`
  once that merges.
- **Rollback:** `git revert`. No migration of its own; reverts cleanly
  independent of MFA-1's table (which stays additive either way).
