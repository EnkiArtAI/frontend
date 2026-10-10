# Batch 06 · ENG-11 (delete 26 dead backend files) + ENC-6 (backend vitest suite)

Status: Delivered — two PRs open, CI red for pre-existing reasons unrelated to this batch.

## Why this batch, out of order

Batch 02 (ENG-01/ENG-19) is blocked: both tasks need the root Next.js app's `node_modules` to
write/run tests, which is off-limits per explicit instruction. Per `AGENT_INSTRUCTIONS.md` §2's own
rule for a blocked batch, this was raised as a question rather than decided unilaterally; the human
chose to jump to Batch 06, which is fully isolated to `frontend/backend/`'s own already-installed
dependencies. See `docs/specs/batches/batch-02.md` for the Batch 02 blocker record.

## What was done

- **PR [#112](https://github.com/EnkiArtAI/frontend/pull/112)** (base `trial-merge-110`) — ENG-11:
  deletes the 26 dead backend files (never-deployed standalone Express server) plus the two test
  files that only covered them, and the stale `tsconfig.json`/`eslint-suppressions.json` entries
  pointing at them. Deletions only. Full import-graph re-verification in `docs/specs/ENG-11.md`.
- **PR [#113](https://github.com/EnkiArtAI/frontend/pull/113)** (base: PR #112's branch, stacked) —
  ENC-6: fixes `backend/vitest.config.ts`'s `@` alias (pointed at `backend/` itself instead of the
  frontend root, breaking `encryption.ts`'s `@/lib/crypto` import inside backend's isolated
  toolchain), adds real unmocked coverage for `encryption.ts` (previously zero), fixes
  `setup.ts`'s missing `FIELD_ENCRYPTION_KEY_B64` stub, and rolls in the earlier
  `variable-substitution.test.ts` mock fix. Details and the explicit CI-join decision gate in
  `docs/specs/ENC-6.md`.
- Both specs written before/with implementation per the lifecycle. Both PRs' local test evidence
  (backend's own isolated `bunx vitest run`) is real and green: 32/32 passing, mutation-checked for
  the alias fix (reverted it, confirmed the exact `Cannot find module '@/lib/crypto'` failure,
  restored it, confirmed green again).

## AC pass/pending

| Task | AC | Status |
|---|---|---|
| ENG-11 | AC-1 (zero dangling imports outside flagged exception) | ✅ Verified |
| ENG-11 | AC-2 (backend suite: 2 failed → 0 failed) | ✅ Verified |
| ENG-11 | AC-3 (configs stay valid JSON) | ✅ Verified |
| ENG-11 | AC-4 (root typecheck/build) | ⏸ Blocked — no root install |
| ENC-6 | AC-1 (0 failed suites) | ✅ Verified |
| ENC-6 | AC-2 (mutation-proof on the alias) | ✅ Verified |
| ENC-6 | AC-3 (variable-substitution still green) | ✅ Verified |
| ENC-6 | AC-4 (root `npm test`/CI join) | ⏸ Decision-gated + blocked on root install |

## CI status (both PRs) — red, but not from this batch's changes

Checked the actual failure logs rather than assuming:
- `lint`/`build`/`tests`/`typecheck` (GitHub Actions): all fail identically on
  `npm ci --no-audit --no-fund` → `npm error ... Missing: @emnapi/runtime@1.10.0 from lock file`.
  This is **ENG-09's already-diagnosed root-lockfile drift**, fixed on a separate branch
  (`fix/ENG-09-ci-green-on-main`, targeting `main`) that has not been merged into `trial-merge-110`.
  Every PR based on `trial-merge-110` will show this same failure until that merge happens — not
  something introduced by ENG-11/ENC-6.
- 3 Vercel checks fail with "Cannot deploy from a private GitHub organization repository on the
  Hobby plan" — an account/billing condition, unrelated to any code in this repo.
- Not running Auto-fix: both causes are outside what a code fix can address from here (one needs
  the root install this session isn't doing, the other needs a Vercel plan change).

## Decisions needed

- **ENC-6's CI-join decision** (Kev, per the task's own 2026-09-24 comment): does the backend
  suite (now 2 files, would shrink to 1 once ENG-02 removes `variable-substitution.ts`) get merged
  into the root `vitest.config.ts`/`npm test` and join CI this sprint? Recommendation in
  `docs/specs/ENC-6.md`: merge, once ENG-02 lands — not applied.
- **`backend/scripts/**` fate** (KG, ENG-11 comment): six scripts now have dangling imports to
  files ENG-11 deleted (`migrate.ts`, `test-phase-2a-integration.ts`, `test-phase-2b-integration.ts`
  import `../database/db`, `../services/index`, `../services/generation-processor`,
  `../workers/generation-worker`). Harmless today (tsconfig-excluded, not run by anything), but
  needs a decision before it's forgotten.
- **`facilitator.ts`'s dummy-secret fallback** (KG, ENG-11 comment): recommend replacing
  `'dummy_secret_key_for_build_time'` with a fail-fast. Not done here (behavior change, doesn't
  belong in a deletions-only PR) — worth its own small task.

## Human steps needed

- Review and merge PR #112, then PR #113 (stacked — #113's base is #112's branch, so merge order
  matters).
- Separately: get ENG-09's fix merged into `trial-merge-110` (or merge `trial-merge-110` into
  `main` per ENG-15, whichever happens first) — until then, CI stays red on every PR against this
  branch for a reason that predates this batch.
- Decide the two open items above (CI-join, `backend/scripts/**`) whenever convenient — neither
  blocks these two PRs from merging.

## New findings (not previously documented)

- The two dead test suites (`oracle-resolver.test.ts`, `payment-system.test.ts`) were already
  failing to even load before this batch touched anything — confirmed by running the suite first,
  unrelated to any change made here.
- `backend/vitest.config.ts`'s alias bug affects two *live* adapters too
  (`services/openai-image-generation.ts`, `services/wavespeed-image-generation.ts`, both import
  `@/lib/generation/*`) — currently untested by anything that would hit real module resolution
  (nothing imports them unmocked in a backend test), so this was latent risk beyond just
  `encryption.ts`. The alias fix in PR #113 covers all of them, not just `encryption.ts`.
- `backend/bun.lock` (created when this engagement bun-installed backend's isolated dependencies)
  is now gitignored rather than committed, to avoid a second-lockfile-format drift alongside
  `backend/package-lock.json` — same category of problem ENG-09 already had to fix once at the
  root.
