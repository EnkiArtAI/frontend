# MFA-3 · Wrap every delete and the removal of a factor (narrowed)

Source: https://app.clickup.com/t/86cbk4fg0
Baseline: main @ 470739a (identical to origin/main, verified 2026-10-11 via compare API)
Stack base: `feat/mfa-1-single-use-stepup` (PR #165) — rule 4.11; CI was green there before the
2026-10-10 billing block. Re-verify green after billing is fixed.
Status: Draft (written 2026-10-11, coordinator; CI billing-blocked — Phase 3+ cannot start until a human fixes GitHub Actions billing)

## Done / Remaining

| Item | State | Evidence (file:line, commit, test) |
|---|---|---|
| Image delete step-up gated | Done | `app/api/images/[id]/route.ts:92-104` — DELETE calls `requireStepUp(req, userId, \`delete-work:${id}\`)`, non-mandatory, resource-bound scope |
| Factor removal gated | Done | 2026-10-08 status comment in `tasks/MFA-3.md`; batch-00-reconcile (2026-10-10). Implementer re-confirms file:line in Phase 0 |
| Guardian removal gated | Done | Same sources as above |
| Step-up on `POST /api/account/delete` | **Remaining** | `app/api/account/delete/route.ts:40-103` — no `requireStepUp` import; POST deletes immediately when no guardians exist (line 70-73) |
| Step-up on library DELETE | **Remaining** | `app/api/library/route.ts:124-139` — DELETE deletes by id + owner filter, no step-up |
| Lockout guard: recovery clears factors | **Reported, deliberately NOT done** | `lib/__tests__/recovery-keeps-factors.test.ts:29-61` — "a guardian recovery resets the password and nothing else (Kev, 2026-10-07): passkeys and code factors stay". Binding decision NEWER than this ticket (written 09-22). Do not change; see Decisions |
| Prompt delete (build + gate) | Out of scope | Prompt DELETE does not exist: `app/api/prompts/[id]/route.ts` exports only GET (line 49) and PATCH (line 229). Open decision per AGENT_INSTRUCTIONS §5 — build nothing until Kev decides |

## Problem

A user with an enrolled second factor can currently delete their account
(`app/api/account/delete/route.ts:70-73`: no guardians → immediate soft-delete)
and delete library items (`app/api/library/route.ts:131-135`) with session alone.
Every other destructive "work" delete already answers a step-up; these two are
the gap. A stolen session can therefore soft-delete the account or wipe the
private library without the second factor every other delete requires.

## Scope

In scope: opt-in (gated-when-enrolled) step-up on `POST /api/account/delete` and
`DELETE /api/library` only.
Out of scope: prompt delete (open decision, doesn't exist on main), recovery/complete
factor clearing (contradicts a binding newer decision), image/factor/guardian
removal (already gated), any change to `requireStepUp` semantics (MFA-1 owns the
single-use consumed store; delete scopes are deliberately NOT single-use — the
MFA-1 branch comment lists `delete-work` among the TTL-reusable scopes).

## Decisions

Binding:
- Tiered matrix (AGENT_INSTRUCTIONS §5): "Delete is gated when a factor is
  enrolled" → `requireStepUp` WITHOUT `{ mandatory: true }`, same as the
  `delete-work:<id>` precedent.
- Kev 2026-10-07 (in code, `recovery-keeps-factors.test.ts:7-11`): guardian
  recovery keeps factors. The ticket's lockout-guard ask (clear
  `webauthn_credentials` on recovery/complete) is superseded. Report, don't fix.
  Residual risk accepted by that decision: a user who loses every factor cannot
  complete gated deletes; guardian recovery still returns a working session.
- Prompt delete waits for Kev (§5 open decision). Confirmed it still doesn't
  exist on main (2026-10-11).

Engineering choices (ours):
- Scopes: `delete-account:<userId>` and `delete-library:<id>` (task text names
  these; matches the `delete-work:${id}` shape at images/[id]:104).
- Account delete gate placement: immediately after session resolution
  (`account/delete/route.ts:46`), before the handle-confirmation read — a
  step-up refusal costs nothing.
- Library gate placement: after the id format check (`library/route.ts:129`),
  before the delete — the scope needs the id; the owner filter stays last so a
  foreign id still answers 404, not a delete.
- Token for scope A must fail on scope B: `verifyStepUpToken` already checks
  `payload.scope === scope` (MFA-1 branch, lib/webauthn.ts). Resource binding
  (delete-library:<idA> token vs idB) is covered by the same exact-match.

## Contract

- `POST /api/account/delete` body/behaviour unchanged. New failure mode before
  anything else: when the session user has ≥1 enrolled factor and no valid
  `X-StepUp-Token` for scope `delete-account:<userId>` → 401
  `{ error, scope, stepUp: true, factors }`. No `deletion_requests` row is
  created in that case.
- `DELETE /api/library?id=<uuid>`: same pattern with scope `delete-library:<id>`.
  401 step-up response before any delete; existing 400/401/404/500 unchanged.
- No DB changes (the `consumed_stepup_tokens` migration belongs to MFA-1, PR
  #165, already prepared, applied by a human).
- No env changes. No emails changed.
- Delete scopes are NOT single-use: a token minted for `delete-library:<id>`
  may delete that same id again within the 5-minute TTL — consistent with the
  `delete-work` classification on the MFA-1 branch. Stated in the code comment.

## Acceptance criteria

- AC-1 Given a user with an enrolled factor, When POST account/delete without a
  step-up token, Then 401 `{ stepUp: true, factors }` and no `deletion_requests`
  row and users row unchanged.
- AC-2 Given the same user and a valid `delete-account:<userId>` token, When
  POST account/delete (no guardians), Then soft-delete happens exactly as today.
- AC-3 Given a user with NO enrolled factor, When POST account/delete, Then the
  delete proceeds without a token (gated-when-enrolled).
- AC-4 Given a valid token for a DIFFERENT scope (e.g. `delete-library:<id>`),
  When POST account/delete, Then 401 (scope mismatch refuses).
- AC-5 Given a user with an enrolled factor and a `delete-library:<idA>` token,
  When DELETE /api/library?id=<idB>, Then 401; with the idA token, Then the row
  for idA is deleted (and only when the owner filter matches).
- AC-6 Given a factor-lookup failure (PostgREST error), When either delete runs,
  Then 503 fail-closed (requireStepUp behaviour, surfaced by the route).
- AC-7 Given a user with no factor and no token, When DELETE /api/library, Then
  proceeds (matrix) — and a foreign id still answers 404.
- AC-8 (documented, no code) recovery keeps factors per Kev 2026-10-07 —
  existing test `recovery-keeps-factors.test.ts` stays green; no new code.

## Test plan

| AC | Test file | Test name ( gist) | Type | Mocks | Manual step |
|---|---|---|---|---|---|
| 1 | `lib/__tests__/account-delete-stepup.test.ts` | account delete asks for step-up when a factor is enrolled | route unit | `fakePostgrest`, supabaseServer mock | — |
| 2 | same | valid delete-account token completes the soft-delete | route unit | same | — |
| 3 | same | no factor enrolled deletes without a token | route unit | same | — |
| 4 | same | foreign-scope token is refused | route unit | same | — |
| 5 | `lib/__tests__/library-delete-stepup.test.ts` | library delete is scope-bound to the id (idA token vs idB) + owner filter still 404s | route unit | `fakePostgrest` | — |
| 6 | both | factor lookup failure answers 503 and deletes nothing | route unit | same | — |
| 7 | library test | no-factor user deletes without a token | route unit | same | — |
| 8 | existing | recovery-keeps-factors stays green | existing suite | — | human: verify on staging after merge if desired |

## Rollout and rollback

Merge order: after PR #165 (MFA-1) merges, rebase this branch on origin/main
(`git fetch && git rebase origin/main`), retarget PR `--base main`.
Rollback: revert the PR; the routes return to their current un-gated behaviour.
No migration, no env, no console steps.
