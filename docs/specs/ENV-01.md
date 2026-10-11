# ENV-01 · Every missing env key answers with a clear sentence (narrowed)

Source: https://app.clickup.com/t/<see bundle ENV-01>
Baseline: main @ 470739a (identical to origin/main, verified 2026-10-11 via compare API)
Branch base: `ci/setup` (PR #162), same as PR #173. No dependency on other open PRs.
Status: Draft (remainder after PR #173; written 2026-10-11, coordinator; CI billing-blocked — Phase 3+ cannot start until a human fixes GitHub Actions billing)

## Done / Remaining

| Item | State | Evidence (file:line, PR) |
|---|---|---|
| Mail class: forgot-password answers 503 in production when `RESEND_API_KEY` unset | **Done — PR #173, unreviewed** | `app/api/auth/password/forgot/route.ts` + `lib/__tests__/forgot-password-env.test.ts` (4 tests incl. the no-enumeration-oracle check). Proved red→green on CI 2026-10-10 before the billing block; owes a Phase 6 mutation check once CI returns |
| Storage class: gallery upload 503 when `BLOB_READ_WRITE_TOKEN` unset | Done (pre-existing) | `app/api/gallery/upload/route.ts:129-131` — "Image uploads are not configured on this environment" |
| Provider breaker side (classify "X is not set" as config) | Done (pre-existing) | `lib/generation/provider-health.ts:61-68` — `classifyFailure` → `{ kind: "config", scope: "route" }`; `lib/__tests__/missing-provider-key.test.ts:21-22` proves the provider fns throw |
| **Provider class: route answers 503, not retryable 500, on a config failure** | **Remaining** | `app/api/generate-image/route.ts:738,764,952` — every provider failure answers `SILENT_FAILURE` 500 even when `classifyFailure(geminiResult.error).kind === "config"`; same pattern expected in `app/api/x402/generate/route.ts` and `app/api/generate-free/route.ts` (implementer greps their 500 sites in Phase 0) |
| **One test per key class** (provider / mail / storage / CDP / OAuth) | **Remaining** | mail: #173 ✓; storage: verify a route-level test exists for gallery upload 503, add if missing; provider: add the route-level 503 test; CDP: establish server-side CDP key reads (grep) — if none exist, document; OAuth: no OAuth routes on main (SOC code is on `be/SOC-oauth`) — defer to batch 08's `not_configured` requirement, note in this spec |
| `chore/dev-env` diff (0299c6a, task text says "reuse what fits") | Diffed 2026-10-11 | 8 commits ahead of main: `lib/dev/*`, `scripts/db-copy.mjs`, dev tooling only — nothing reusable for the provider-503 work |

## Problem

A provider that is not configured (key unset) is a permanent, non-retryable
condition, but the paid generation routes answer it exactly like a transient
outage: `SILENT_FAILURE` 500 at `generate-image/route.ts:738`. The buyer retries
( paying again after a fresh quote), the breaker opens, and nobody is told the
real sentence: the environment is missing a key. ENV-01: a missing key answers
503 "<Provider> is not configured on this environment".

## Scope

In scope: map config-kind provider failures to 503 with the provider named, in
the three generation routes (`generate-image`, `x402/generate`,
`generate-free`); one route-level test per key class; mutation checks for the
new tests.
Out of scope: changing `classifyFailure`/breaker semantics (done); moderation
key classes (`prompt-check.ts:116`, `image-check.ts:108,125` already answer
"unavailable" → the routes' existing 503 paths — verify in Phase 0, extend a
test only if a gap appears); mail beyond #173; storage beyond the existing 503;
client-side CDP config; OAuth start routes (don't exist on main).

## Decisions

Binding:
- ENV-01 (task text): missing provider key → 503 "<Provider> is not configured
  on this environment", never a retryable 500. The breaker side is done; only
  the route answer remains.
- The provider's own error text stays out of the buyer's response
  (generate-image/route.ts:736-737 rationale) — the 503 names the PROVIDER from
  `route.provider` (a catalogue value the buyer already knows from the model),
  never the raw error string.

Engineering choices (ours):
- Map at the existing failure sites: `classifyFailure(geminiResult.error)` →
  when `kind === "config"`, return 503 `{ error: "<Provider> is not configured
  on this environment" }`; every other kind keeps `SILENT_FAILURE` 500. Small
  local helper in each route (or one shared in `lib/generation/provider-health.ts`
  if the Phase-1 read shows all three routes want it identical) — fail closed:
  classification failure defaults to today's 500, never to 503.
- Nothing is charged in these paths today (release-free/refund logic is at the
  sites already); the 503 changes only the status line and body, no payment
  flow edits.

## Contract

- `POST /api/generate-image`, `POST /api/x402/generate`, `POST /api/generate-free`:
  on provider failure whose classified kind is `config` → HTTP 503, body
  `{ error: "<Provider> is not configured on this environment" }` (Provider =
  "Gemini" | "OpenAI" | "WaveSpeed" as resolved by the route). All other
  failures unchanged.
- No DB changes, no env changes, no emails. `.env.example` already lists the
  provider key names (verify in Phase 0).

## Acceptance criteria

- AC-1 Given `GEMINI_API_KEY` (and alternates) unset in production, When a paid
  generation resolves to Gemini, Then 503 "<Provider> is not configured on
  this environment" (not 500), nothing charged, failure still recorded/breaker
  still told.
- AC-2 Same for OpenAI and WaveSpeed.
- AC-3 Given a transient provider failure (5xx/network), the answer is still
  today's `SILENT_FAILURE` 500 — the new 503 must not leak onto real outages.
- AC-4 Mail class: #173's tests stay green; mutation check performed post-CI.
- AC-5 Storage class: a route-level test asserts gallery upload answers 503
  when the blob token is unset (exists? verify; add if missing).
- AC-6 CDP class: Phase 0 grep of server-side CDP key reads is recorded in this
  spec with file:line; if a server route needs a CDP key, it gets the same 503
  sentence + test; if none, the class is closed as "client-side only".
- AC-7 OAuth class: closed as deferred to batch 08 (routes don't exist on
  main); noted here so the class isn't silently dropped.

## Test plan

| AC | Test file | Test name (gist) | Type | Mocks |
|---|---|---|---|---|
| 1-2 | `lib/__tests__/provider-key-503.test.ts` | config-kind provider failure answers 503 naming the provider (one per provider) | route unit | `fakePostgrest`, provider fns mocked to throw "X is not set", fetch stubbed |
| 3 | same | transient failure keeps SILENT_FAILURE 500 | route unit | same |
| 4 | existing `forgot-password-env.test.ts` | stays green; mutation: delete the 503 guard → red | existing | — |
| 5 | `lib/__tests__/gallery-upload-session.test.ts` (extend or verify existing) | unset blob token → 503 | route unit | existing pattern |
| 6-7 | review | grep evidence recorded in spec | review | — |
| all | Phase 6 | one mutation per AC on the new guard: revert the classification branch → test red | mutation | scratch `mut/env-01` branch, CI red, branch deleted |

## Rollout and rollback

Merge order: independent — base `ci/setup`, retarget `--base main` when #162
merges. Can merge before or after #173 (different files).
Rollback: revert the PR; routes answer as today. No migration, no env, no
console steps.
