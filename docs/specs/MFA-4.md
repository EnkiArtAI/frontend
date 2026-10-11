# MFA-4 · Opt in step up on adding prompts and images (narrowed)

Source: https://app.clickup.com/t/86cbk4fg1
Baseline: main @ 470739a (identical to origin/main, verified 2026-10-11 via compare API)
Stack base: `feat/mfa-1-single-use-stepup` (PR #165) — same as MFA-3; dependent
task, same agent, runs after MFA-3 on a branch stacked on it.
Status: Draft (written 2026-10-11, coordinator; CI billing-blocked — Phase 3+ cannot start until a human fixes GitHub Actions billing)

## Done / Remaining

| Item | State | Evidence (file:line, commit, test) |
|---|---|---|
| Gallery upload uses real session auth | Done | `app/api/gallery/upload/route.ts:119-123` — `resolveSessionUserId`, banned sessions resolve to nobody (MFA-2 / REC-9) |
| Opt-in step-up on `POST /api/prompt` | **Remaining** | `app/api/prompt/route.ts:267-802` — no step-up anywhere in the POST handler |
| Opt-in step-up on gallery upload | **Remaining — sequenced after REC-8** | `app/api/gallery/upload/route.ts:113` — no step-up. Wave plan: "the gallery upload step up goes last, after B's REC-8 PR is green, rebased on it" (REC-8 rewrites every upload site's storage path) |
| One-time UI nudge flag | **Remaining** | No signal exists today for "this user has no factor" on success responses |
| 5-minute tradeoff comment | **Remaining** | Not present (the tradeoff doesn't exist yet either) |

## Problem

Step-up 2FA today protects only destructive/money actions. Creators with an
enrolled factor can add prompts and gallery images with session alone, so a
stolen session can publish under a victim's name. The tiered matrix makes
additions opt-in: enforced only for users who enrolled a factor, plus a nudge
for those who haven't.

## Scope

In scope: opt-in (non-mandatory) step-up on `POST /api/prompt` (creates only)
and `POST /api/gallery/upload`; a `stepUpNudge` flag on both success responses;
the tradeoff comment. Enforced only when the caller has ≥1 enrolled factor.
Out of scope: prompt edits/updates (`body.id` present — the matrix says
"adding"; the edit gap is reported below), deletes (MFA-3), any money path,
`generate-image` (recording pipeline, batch 03/04 territory), REC-8 storage
changes (this branch must rebase on REC-8 for the gallery-upload part).

## Decisions

Binding:
- Tiered matrix (§5): "Adding prompts and images is opt in with a nudge" →
  `requireStepUp` WITHOUT `{ mandatory: true }`; users with no factor proceed.
- Not single-use: `add-prompt`/`add-image` are not money scopes (MFA-1 branch
  consumed store covers withdraw/key-export only). Tokens stay TTL-reusable —
  this IS the 5-minute tradeoff and must be stated in a code comment at the
  gate (task text requires it): one tap authorizes creations for 5 minutes,
  acceptable for reversible creator actions.

Engineering choices (ours):
- Scopes: `add-prompt`, `add-image` (plain, matching the `add-factor` family).
- Prompt gate covers CREATE only (`!body.id`): the matrix says "adding", and
  gating the shared POST handler would also gate re-saves/edits, which the
  ticket does not ask for. Gate placement: after the creator/owner resolution
  (route.ts:418-448) where the userId is known, BEFORE the rate limit and all
  paid checks — a step-up refusal must never pay for a moderation call.
  Gap reported, not fixed: a hijacked session can still EDIT/delist prompts.
  If Kev wants edits gated too it is a one-line change on this branch.
- Gallery upload gate: after the 401 check (route.ts:121), before the rate
  limit and paid image checks. LANDS AFTER REC-8: branch rebases on
  `feat/rec-8-*` once that PR is CI-green; until then this PR covers only
  POST /api/prompt + nudge, with the gallery part as the final commit(s).
- Nudge contract: on SUCCESS responses, when the caller has zero enrolled
  factors, add `stepUpNudge: true` (JSON field on both routes). "One time" is
  honoured client-side (show once, remember locally) — the backend provides
  the stateless boolean; it says nothing about frequency.
  Implementation: export `enrolledFactors` from `lib/webauthn.ts` (additive
  `export` keyword only — no behaviour change) and read it on the success path
  of both routes. One extra indexed `mfa_factors` select per successful save,
  paid only when the save succeeded.
  Alternatively the gate's own query could be reused by extending
  `requireStepUp`'s return type — rejected: changes the shared helper's
  contract mid-wave for a boolean.

## Contract

- `POST /api/prompt`: request/response unchanged. New failure mode for
  factor-enrolled creators on creates: 401 `{ error, scope: "add-prompt",
  stepUp: true, factors }` before any paid check runs; nothing stored.
- `POST /api/gallery/upload`: same with scope `add-image` (after rebase on
  REC-8). 401 before the blob write and before the paid image check.
- Success responses gain `stepUpNudge: true` iff the caller has zero enrolled
  factors; otherwise the field is absent (or false — pick absent, smaller).
- No DB changes, no env changes, no emails.

## Acceptance criteria

- AC-1 Given a creator with an enrolled factor, When POST /api/prompt (new
  prompt) without a token, Then 401 `{ stepUp: true, factors }` and no prompt
  row, no paid check called.
- AC-2 Given a valid `add-prompt` token, When the same create, Then it
  proceeds exactly as today.
- AC-3 Given a creator with no factor, When the same create, Then it proceeds
  without a token and the response carries `stepUpNudge: true`.
- AC-4 Given a creator with an enrolled factor, When POST with `body.id`
  (edit), Then NOT gated (updates stay open; reported gap).
- AC-5 Given a valid `add-image` token but prompt scope (or vice versa), Then
  401 — scopes don't cross.
- AC-6 (after REC-8 rebase) Given a factor-enrolled uploader, When gallery
  upload without a token, Then 401 before any blob write or image check; with
  a token, upload proceeds; no-factor upload proceeds + `stepUpNudge: true`.
- AC-7 The 5-minute tradeoff comment exists at both gate sites.

## Test plan

| AC | Test file | Test name (gist) | Type | Mocks | Manual step |
|---|---|---|---|---|---|
| 1 | `lib/__tests__/prompt-add-stepup.test.ts` | create asks for step-up when factor enrolled | route unit | `fakePostgrest`, moderation/fetch stubs (vitest.setup throws on unmocked fetch) | — |
| 2 | same | valid add-prompt token completes the create | route unit | same | — |
| 3 | same | no-factor create proceeds with stepUpNudge | route unit | same | — |
| 4 | same | edit (body.id) is not gated | route unit | same | — |
| 5 | same | cross-scope token refused | route unit | same | — |
| 6 | `lib/__tests__/gallery-upload-stepup.test.ts` | upload gate order: step-up before blob+check (after REC-8 rebase) | route unit | same | — |
| 7 | both | comment present (checked in review, not a test) | — | — | reviewer confirms |

## Rollout and rollback

Merge order: PR #165 (MFA-1) → MFA-3 PR → this PR for the prompt+nudge part →
rebase on REC-8's branch for the gallery part (or a stacked follow-up PR if
REC-8 is still open). Human merges everything.
Rollback: revert the PR; gates disappear, responses lose the nudge field
(frontend must treat the field as optional — note it in the PR body).
No migration, no env, no console steps.
