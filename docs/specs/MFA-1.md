# MFA-1 · Single-use step-up tokens for money scopes
Source: https://app.clickup.com/t/86cbk4ffy
Status: In progress

## Done / Remaining

| Item | Status |
| --- | --- |
| Mandatory mode (`requireStepUp({ mandatory })`, 403 `{ enroll }`) | Done (pre-existing) |
| Fail closed on a broken factor lookup / no session | Done (pre-existing) |
| Scope regex, multi-factor `enrolledFactors` | Done (pre-existing) |
| `jti` on every minted step-up token | This PR |
| DB-backed consumed-token store (`consumed_stepup_tokens`) | This PR |
| Single-use enforcement for money scopes (`export`, `withdraw:*`) | This PR |
| Scratchpad "7 case suite" migration into `lib/__tests__/webauthn.test.ts` | **Not done** — superseded. KG's 2026-10-08 status confirms mandatory/fail-closed/regex/multi-factor already shipped and covered (`lib/__tests__/mfa.test.ts` "the step-up gate" block, `image-delete.test.ts`, `withdraw-stepup.test.ts`). Re-deriving a parallel suite for already-shipped, already-tested behaviour is out of scope per the coordinator's explicit instruction ("do not touch them beyond what single-use requires"). |

## Problem

`lib/webauthn.ts`'s `mintStepUpToken`/`verifyStepUpToken` mint a short-lived (5
minute) HS256 JWT bound to `(userId, scope)` only. Nothing stops the SAME token
from authorizing the gated action repeatedly, every time, until it expires. For
a scope with no per-call target (`export`, and — before BAN-8 — `wallet`) or a
scope bound to something coarser than the action itself, one human step-up (one
TOTP code, one passkey tap) can be replayed for the whole TTL window. For
money-moving scopes this is a real window: a stolen or intercepted
`X-StepUp-Token` is a bearer credential good for 5 minutes, not one use.

The fix must be DB-backed, not in-memory (`lib/rate-limit.ts`'s pattern):
Vercel runs many instances, and an in-memory consumed-set on instance A is
invisible to instance B.

## Scope

**In scope:**
- Add a `jti` (random UUID) claim to every token `mintStepUpToken` issues.
- A new table, `consumed_stepup_tokens` (migration
  `migrations/2026-10-09-consumed-stepup-tokens.sql`), service-role only.
- `requireStepUp`: for a "money scope" (`scope === "export"` or
  `scope.startsWith("withdraw:")`), after the signature/sub/scope check
  passes, claim the token's `jti` with a plain conditional insert before
  treating the token as valid. A duplicate `jti` (23505) is a replay →
  refused exactly like an invalid token. A genuine store error is NOT a pass
  — fail closed (503), never a silent authorize.
- Non-money scopes (`delete-work:*`, `remove-factor:*`, `add-factor`,
  `guardians`, `wallet`) are untouched: still reusable for any number of
  calls inside the 5 minute TTL, as today. (BAN-8 re-binds `withdraw:*` to a
  request id instead of a destination; that is BAN-8's change, not this
  one — this task only builds the single-use mechanism and wires it to the
  two scopes MFA-1's own text names: "withdraw, key export".)

**Out of scope:**
- Changing `mandatory` wiring for any route (coordinator's instruction).
- Changing the `SCOPE` regex (BAN-8 touches the `withdraw:` branch).
- The stale "move the scratchpad 7-case suite" item (see Done/Remaining).
- Token revocation / logout-everywhere (not asked for).
- Pruning old `consumed_stepup_tokens` rows — the token's own 5 minute TTL
  means an old row is forever inert; a cron to delete rows older than, say, 1
  day is pure housekeeping and not required for correctness. Flagged as a
  follow-up, not blocking.

## Decisions

1. **Which scopes are "money scopes"?** `export` and `withdraw:*`, per MFA-1's
   own text ("money scopes (withdraw, key export)"). `wallet` (the CDP
   unlock scope) is intentionally left alone: it isn't a single action, it
   stamps `auth_sessions.stepup_at`/`stepup_seen_at` for a sliding 2 h/15 min
   unlock window (`afterStepUp`, `walletUnlocked`) — replaying it just
   re-stamps the same session the user already unlocked, which is idempotent
   and not a new authorization. No sign this needs single-use; not touched.
2. **Consumption mechanism:** a plain `INSERT ... ON unique(jti)` claimed via
   the 23505 error path (same pattern `lib/mfa.ts`'s `begin()` and
   `lib/payments/withdraw.ts`'s `insertWithdrawal` already use for
   insert-wins-once races), not a Postgres function with an advisory lock.
   No race window matters here beyond "the row either exists or it doesn't";
   a function/lock would be strictly more machinery for the same guarantee.

## Contract

- `mintStepUpToken(userId, scope): Promise<string>` — unchanged signature,
  now includes `jti` in the JWT.
- `requireStepUp(req, userId, scope, opts)` — unchanged signature and return
  type (`NextResponse | null`). New behaviour only for money scopes: a second
  presentation of the same token (same `jti`) answers the same 401
  `{ stepUp: true, factors }` as an unrecognized token, and a store failure
  answers 503 `{ error }` (matches the existing fail-closed shape used for a
  broken `enrolledFactors` lookup).
- New table `public.consumed_stepup_tokens(jti uuid PK, user_id uuid, scope
  text, consumed_at timestamptz)`. No new PostgREST surface — read/written
  only from `lib/webauthn.ts`.

## Acceptance criteria

- **AC-1 (replay refused):** Given a user with a factor and a money-scope
  token already used once, When the same token is presented again inside its
  TTL, Then `requireStepUp` answers 401 (not the pass it would have given
  before this change). **Pass** — `lib/__tests__/stepup-single-use.test.ts`.
- **AC-2 (store failure fails closed):** Given the `consumed_stepup_tokens`
  insert fails for a reason OTHER than a duplicate key (e.g. the connection
  drops), When `requireStepUp` is called with an otherwise-valid money-scope
  token, Then it answers 503, never `null` (never a silent pass). **Pass**.
- **AC-3 (no regression on non-money scopes):** Given a `delete-work:<id>`
  token, When it is presented twice, Then both calls succeed exactly as
  before this change. **Pass**.
- **AC-4 (fails closed pre-existing, untouched):** no-session → 401, broken
  factor lookup → 503, mandatory+unenrolled → 403 `{ enroll }`. Already
  covered by `lib/__tests__/mfa.test.ts` "the step-up gate"; re-run here only
  as a smoke check, not re-specified.

## Test plan

| AC | Test | File |
| --- | --- | --- |
| AC-1 | "refuses the same export token twice" | `lib/__tests__/stepup-single-use.test.ts` |
| AC-2 | "fails closed when the consumed-token store errors" | same |
| AC-3 | "leaves a non-money scope exactly as reusable as before" | same |
| AC-4 | smoke only (already specified/tested elsewhere) | `lib/__tests__/mfa.test.ts` (unchanged, not re-touched) |

## Rollout and rollback

- **Human step required before merge:** run
  `migrations/2026-10-09-consumed-stepup-tokens.sql` in the Supabase SQL
  editor, then read `consumed_stepup_tokens` back over PostgREST and paste
  the column list into the ClickUp task (CONTRIBUTING.md §4). No service-role
  key is available to this agent; it cannot probe or apply the migration
  itself.
- **Order:** this PR first; BAN-8 stacks on top of it (reuses
  `consumeStepUpToken`/the same table for its request-id-bound withdraw
  scope).
- **Rollback:** plain `git revert`. The migration is additive (`CREATE TABLE
  IF NOT EXISTS`) and safe to leave in place even if the code is reverted —
  an unused table with RLS on and no policies.
- **Degrades safely if the migration hasn't run yet:** a missing table
  surfaces as a generic insert error (not 23505) at `consumeStepUpToken`,
  which `requireStepUp` already treats as a store failure → 503, fail
  closed. Money actions simply refuse until the migration lands; they never
  silently skip the single-use check.
