# ENC-6 · Backend vitest suite runs in npm test
Source: https://app.clickup.com/t/86cbk4fff
Status: Partially implemented — decision-gated on the rest

## Problem

The task's stated root cause ("`backend/vitest.config.ts`'s `@` alias points at `backend/`, so
`backend/encryption.ts` importing `@/lib/crypto` breaks: 9 of 29 tests fail") was re-probed rather
than trusted, since it didn't match what I'd already fixed earlier in this engagement (a separate,
unrelated sync/async mock bug in `variable-substitution.test.ts`, also 9 failures — coincidence in
count, not the same bug). Re-probing (2026-09-27) found:

- The `@` alias bug is real: `backend/vitest.config.ts`'s `resolve.alias` pointed `@` at `backend/`
  itself. `backend/encryption.ts:24` imports `@/lib/crypto` — but there is no `backend/lib/`
  directory; the real `lib/crypto.ts` lives at the **root** of `frontend/`. The root
  `tsconfig.json` already maps `@/lib/*` → `./lib/*` and includes `backend/**/*`, so this import
  resolves correctly for the actual Next.js app (which is how `encryption.ts` is really consumed —
  `app/api/generations/route.ts` etc. import it via `@/backend/encryption`). It only breaks inside
  backend's own **isolated** vitest/tsc toolchain, which has its own, different `@` mapping.
  Same bug pattern also affects `backend/payment-verification.ts` (`@/lib/supabaseServer`, but this
  file is deleted by ENG-11) and the two live adapters `services/openai-image-generation.ts` /
  `services/wavespeed-image-generation.ts` (`@/lib/generation/*` — still live, still affected).
- The specific "9 of 29 fail" symptom the task describes did not reproduce as described: running
  `bunx vitest run` in `backend/` before this fix showed 29/29 passing in
  `variable-substitution.test.ts` (that file only ever imports `encryption.ts` through a
  `vi.mock(...)` factory, which never triggers real module resolution of `@/lib/crypto`) and 2
  entirely separate suites failing to load for an unrelated reason (`@jest/globals` not found —
  legacy jest-style tests, not vitest). The `@` alias bug was latent: nothing currently imports the
  real, unmocked `encryption.ts` or the two `@/lib/generation/*`-importing adapters from a test.
- Both of those 2 failing suites (`oracle-resolver.test.ts`, `payment-system.test.ts`) test dead
  code that ENG-11 removes. Confirms the batch table's own note, "ENC-6 must follow ENG-11": once
  ENG-11 lands, the only remaining backend test was `variable-substitution.test.ts`.

## Scope

**In scope (this commit, stacked on ENG-11 in this batch):**
- Fix `backend/vitest.config.ts`'s `@` alias to point at the **frontend root** (one level up from
  `backend/`), matching how the real app resolves it, instead of at `backend/` itself.
- Add a regression test that exercises the real, unmocked `backend/encryption.ts` →
  `lib/crypto.ts` path (previously zero direct coverage — every existing reference to
  `encryption.ts` went through a mock), proving the alias actually works and stays working.
- Fix `backend/__tests__/setup.ts`: it stubbed only the legacy `PROMPT_ENCRYPTION_KEY` env var;
  `lib/crypto.ts`'s keyring unconditionally requires `FIELD_ENCRYPTION_KEY_B64` regardless of the
  legacy key's presence, so the new unmocked encryption test would fail on missing env var without
  this. Added a test-only key.
- Roll in the pre-existing, already-verified fix to `services/__tests__/variable-substitution.test.ts`
  (9 tests were mocking the real, synchronous `decryptPrompt` as if it were async —
  `mockResolvedValue`/`mockRejectedValue` instead of `mockReturnValue`/`mockImplementation`, which
  handed the source code a `Promise` object instead of a plain string). This was found and fixed
  earlier in this engagement, before ENG-11/ENC-6 were reached; committing it here since it belongs
  to the same "the backend suite genuinely passes" goal and touches the same file family.
- `.gitignore`: stop tracking `bun.lock` inside `backend/` — this repo standardized on npm
  (`package-lock.json` is the tracked lockfile everywhere else, including `backend/`'s own); bun
  was used here only for local install speed, not as a package-manager switch, and a second
  lockfile format is exactly the kind of drift ENG-09 already had to fix once at the root.

**Out of scope — decision gate, per KG's 2026-09-24 comment ("Kev... decides whether the backend
suites and the excluded tsconfig paths join CI this sprint"):**
- Merging `backend/`'s test include into the **root** `vitest.config.ts` / root `npm test`, and
  wiring it into CI. This is the task's other stated option ("run it from the root config or merge
  into the root vitest include, and make CI run it") and is exactly the decision KG's comment says
  is still open. **Recommendation** (not applied): merge is the better long-term shape — running
  backend tests through the isolated `backend/` toolchain means maintaining a second, parallel
  vitest config indefinitely for what is now a single test file
  (`variable-substitution.test.ts` plus this new `encryption.test.ts`); once ENG-02 also removes
  `variable-substitution.ts` itself (Batch 05), only `encryption.test.ts` would be left, which
  could just as easily live under `lib/__tests__/` and run through the root suite that already
  correctly resolves `@/lib/*`. Deferred to whoever makes the CI-join call.
- Even if the merge decision were made now, proving it (a green `npm test` run in CI or locally)
  needs the root `node_modules`, which this session is not installing. Blocked the same way as
  Batch 02, on top of being decision-gated.
- `backend/vitest.config.ts` itself is not deleted (the task's "Also:" line suggests it, once
  merged into root) — see `docs/specs/ENG-11.md`'s Out-of-scope section for why it's kept for now.

## Decisions

Recorded, not invented: whether the backend suite (now just 2 test files) joins the root `npm test`
/ CI this sprint is Kev's call per the existing comment. Recommendation above (merge, once ENG-02
also lands) is offered for when that decision is made — not applied unilaterally.

## Contract

- `backend/vitest.config.ts`: `resolve.alias['@']` changes from `new URL('./', import.meta.url)` to
  `new URL('../', import.meta.url)` (backend/ → frontend root).
- `backend/__tests__/setup.ts`: adds `process.env.FIELD_ENCRYPTION_KEY_B64` (test-only key).
- `backend/__tests__/encryption.test.ts`: new file, 3 tests (configured check, encrypt/decrypt
  round trip, tamper rejection) against the real, unmocked `encryption.ts`.
- `backend/services/__tests__/variable-substitution.test.ts`: 9 mock calls corrected from
  `mockResolvedValue`/`mockRejectedValue` to `mockReturnValue`/`mockImplementation(() => { throw })`
  to match `decryptPrompt`'s real (synchronous) signature.
- `.gitignore`: `bun.lock` added.
- No production runtime code changes — every edit here is to test config, test setup, or test
  files.

## Acceptance criteria

- **AC-1:** `bunx vitest run` inside `backend/` (after ENG-11's deletions) shows 0 failed suites.
  **Verified:** 2 files, 32 tests, all passing.
- **AC-2 (mutation-proven):** reverting the alias fix (`@` back to `./` instead of `../`)
  reproduces the exact failure the task describes in kind — `Cannot find module '@/lib/crypto'` —
  proving `encryption.test.ts` actually exercises the fixed code path rather than passing
  vacuously. **Verified**, then re-applied the fix and confirmed green again.
- **AC-3:** the pre-existing 9-test mock fix in `variable-substitution.test.ts` still holds: all 29
  of its tests pass. **Verified** (part of the same 32/32 run).
- **AC-4 (not applicable yet):** backend tests run under root `npm test` / CI. Decision-gated (see
  Scope) and blocked on root install; not attempted.

## Test plan

| AC | Method | Result |
|---|---|---|
| AC-1 | `bunx vitest run` in `backend/` | 2 files / 32 tests, 0 failed |
| AC-2 | Temporarily reverted the alias, re-ran `encryption.test.ts` alone, confirmed the exact `Cannot find module '@/lib/crypto'` error, then restored the fix and re-ran full suite green | Red confirmed, then green confirmed |
| AC-3 | Same full suite run as AC-1 includes all 29 `variable-substitution.test.ts` tests | All pass |
| AC-4 | N/A — decision-gated, root install blocked | Not run |

## Rollout and rollback

- **Order:** lands after ENG-11 in this batch (same worktree, stacked commit) — depends on the two
  dead jest-style suites already being gone so the vitest run is unambiguous.
- **Rollback:** plain `git revert`; no data, no migrations, test-only changes.
- **Follow-up, not done here:** the root-CI-join decision (Kev), and — once made — actually merging
  the include and proving it under a root install.
