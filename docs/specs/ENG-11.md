# ENG-11 · Delete the 26 dead backend files, their tsconfig excludes, the backend vitest config and the unused Mongo packages
Source: https://app.clickup.com/t/86cbjvk7q
Status: Implemented

## Problem

`backend/` mixes 9-11 files the live Next.js app actually imports with ~26 files belonging to a
never-deployed standalone Express server (`vercel.json`'s framework is `nextjs`;
`START_GENERATION_WORKER` is unset). Re-verified independently (2026-09-27, branch
`trial-merge-110`) by grepping every `.ts`/`.tsx` file in the repo (excluding `node_modules`,
`.next`) for imports of each candidate dead file:

- The 9 live imports from `app/` and `lib/` are exactly: the four image adapters
  (`services/{gemini,openai,wavespeed,pollinations}-image-generation.ts`) plus `services/types`,
  `solana-x402-verifier`, `encryption`, `x402-engine`, `facilitator` (imported by
  `app/middleware.ts`). `database/schema.ts` and `logger.ts` are pulled in transitively by
  `facilitator.ts`/`x402-engine.ts`, not imported directly from `app/`/`lib/`.
- `services/variable-substitution.ts` is also live today (used by
  `app/api/generations/route.ts`) but is explicitly out of scope here — it is scheduled for
  removal under ENG-02 (Batch 05, not yet reached) alongside the whole legacy generations API. Not
  touched.
- The 26-file "dead" set forms a single self-contained import subgraph: every reference to any of
  them comes from another file also in the dead set. Zero references from any live file, from
  `app/`, `lib/`, or `components/`.
- Two existing test files, `backend/__tests__/oracle-resolver.test.ts` and
  `backend/__tests__/payment-system.test.ts`, test only this dead code and were already failing to
  even load (`Failed to load url @jest/globals`) before this change — confirmed by running
  `bunx vitest run` before touching anything.

## Scope

**In scope (this PR — deletions only, per the task's own note "ENG-11 PR is deletions only"):**
- Delete the 26 dead files/dirs listed in the task body: `app.ts`, `index-dev.ts`, `index-prod.ts`,
  `workers/` (`generation-worker.ts`), `services/generation-processor.ts`,
  `services/gemini-rate-limiter.ts`, `services/gemini-retry-handler.ts`, `oracles/` (3 files),
  `price-oracle.ts`, `price-oracle-complex.ts`, `token-registry.ts`, `token-risk-engine.ts`,
  `multi-token-engine.ts`, `chain-selector.ts`, `cross-chain-aggregator.ts`, `payment-system.ts`,
  `payment-verification.ts`, `routes/` (`generations.ts`), `middleware/` (`x402-payment.ts`),
  `gemini.ts`, `database/db.ts`, `services/index.ts`, `services/test-gemini.ts`.
- Delete `backend/__tests__/oracle-resolver.test.ts` and `backend/__tests__/payment-system.test.ts`
  as a direct consequence — they exclusively test the files above; leaving them would mean two
  test files importing modules that no longer exist.
- Remove the now-stale `tsconfig.json` exclude entries that pointed at deleted files
  (`backend/app.ts`, `backend/routes.ts`, `backend/index-dev.ts`, `backend/index-prod.ts`,
  `backend/price-oracle-complex.ts`, the three `backend/oracles/*.ts` entries). Note:
  `"backend/routes.ts"` was already a dead entry before this change — no such file ever existed
  (the real path was the `routes/` directory); removed along with the rest.
- Remove the matching stale entries from `eslint-suppressions.json` for every deleted file.

**Out of scope / explicitly deferred (per KG's 2026-09-26 comment on this task):**
- **`backend/scripts/**`** (six self-affirming validators, `migrate.ts`, `run-migration.ts`,
  `test-generations-api.ts`, `test-phase-2a-integration.ts`, `test-phase-2b-integration.ts`) and
  `COMPLETE_DATABASE_MIGRATION.sql` — KG flagged this as a separate decision, not yet made. **Side
  effect of this PR:** three scripts now have dangling imports of deleted modules —
  `scripts/migrate.ts` (`../database/db`), `scripts/test-phase-2a-integration.ts` and
  `test-phase-2b-integration.ts` (`../services/index`, `../services/generation-processor`,
  `../workers/generation-worker`). This does not break typecheck/tests/build: `backend/scripts/**`
  is already excluded from the root `tsconfig.json` and none of these scripts are under any
  `__tests__/` directory, so nothing imports or runs them automatically. Flagged here rather than
  silently left for someone to trip over; resolving it is the `backend/scripts/**` decision above.
- Whether `backend/scripts/**` and `backend/__tests__/**` join CI — open, per KG's comment, on a
  separate decision (DEC-02 per the comment). Their `tsconfig.json` excludes are left in place
  unchanged.
- `backend/facilitator.ts`'s `'dummy_secret_key_for_build_time'` fallback (line ~26) — KG flagged
  this as needing a fail-fast instead. **Not done here**: this is a behavior change to a live file,
  and ground rule 8 ("one concern per PR, no mixing deletions with behaviour changes") keeps it out
  of a deletions-only PR. Recommend a small follow-up task/PR.
- Removing the `mongodb`/`mongoose` packages from **root** `package.json` (`frontend/package.json`
  lines ~76-77). Confirmed via repo-wide grep: zero `.ts`/`.tsx` files anywhere import `mongodb` or
  `mongoose`, and neither package appears in `backend/package.json` (only in the root one) — so
  removal is safe in principle. **Not applied**: removing a dependency from `package.json` without
  also regenerating `package-lock.json` (which needs a real `npm install`/`npm ci` run) leaves the
  lockfile out of sync with `package.json`, which is exactly the failure mode ENG-09 already fixed
  once (`npm ci`'s `EUSAGE` on lockfile drift). Root-level install is currently off-limits per
  explicit instruction. Recommend bundling this one-line removal into whichever future change
  regenerates the root lockfile (e.g. ENG-09's own pending rollout, or Batch 02 whenever it
  resumes).
- Deleting `backend/vitest.config.ts` — the task's own "Also:" line lists it for deletion, but
  ENC-6 (this batch's second task, which must run after this one per the batch table) still needs
  a way to run the one remaining real backend test (`services/__tests__/variable-substitution.test.ts`)
  until/unless it's actually merged into the root vitest config. Deleting the config here would
  strand that test with no runner. Left in place; ENC-6 owns its fate.

## Decisions

None new. Deferred items above are pre-existing open decisions from KG's comment, restated for
visibility, not invented here.

## Contract

- 24 backend source files + 2 test files (26 total, matching the task title) removed.
- `tsconfig.json`: 7 stale exclude entries removed (6 real, 1 already-dead `backend/routes.ts`
  reference), `backend/__tests__/**/*` and `backend/scripts/**/*` excludes kept.
- `eslint-suppressions.json`: entries for all 14 deleted files that had one removed; entries for
  `backend/scripts/**` and the 12 kept-live files untouched.
- No production code paths change behavior — the deleted files were never reachable from any
  deployed entry point.

## Acceptance criteria

- **AC-1:** `grep`-based reachability check across the whole repo (excluding `node_modules`,
  `.next`) finds zero remaining imports of any deleted module from any file **outside**
  `backend/scripts/**` (the one explicitly-flagged, out-of-scope exception). **Verified.**
- **AC-2:** `backend/`'s own isolated vitest suite (`bunx vitest run` inside `backend/`, using its
  already-installed `node_modules`) collects and passes with the two dead suites gone: before,
  2 failed suites / 1 passed (29 tests); after, 0 failed / 1 passed (29 tests). **Verified.**
- **AC-3:** `tsconfig.json` and `eslint-suppressions.json` remain valid JSON/JSON5 after edits.
  **Verified** (`node -e "JSON.parse(...)"` on both).
- **AC-4 (not verified — root install blocked):** root `npm run typecheck` / `npm run build` pass
  without the deleted files. Cannot run without the root `node_modules` this session is not
  installing. The `grep` reachability check (AC-1) is the best available substitute: TypeScript
  errors from dangling imports and grep-detected dangling imports are the same failure mode, and
  AC-1 found none outside the flagged `backend/scripts/**` exception.

## Test plan

| AC | Method | Result |
|---|---|---|
| AC-1 | `grep -rEn` for each deleted module's basename across the repo, before and after deletion | Zero live references after; 3 expected-and-flagged dangling references inside `backend/scripts/**` |
| AC-2 | `bunx vitest run` inside `backend/`, before and after | Before: 2 failed suites (pre-existing, unrelated to this change) + 29 passing; After: 29 passing, 0 failed |
| AC-3 | `node -e "JSON.parse(...)"` on both edited config files | Both parse cleanly |
| AC-4 | Root `npm run typecheck`/`build` | Blocked on root install — not run |

## Rollout and rollback

- **Rollback:** plain `git revert` — no data, no migrations, no runtime behavior changed.
- **Order:** lands before ENC-6 (same batch), which depends on the two dead test suites already
  being gone.
- **Follow-ups spawned, not done here:** `backend/scripts/**` decision (KG), `facilitator.ts`
  fail-fast fallback (KG), root `mongodb`/`mongoose` removal (blocked on root install).
