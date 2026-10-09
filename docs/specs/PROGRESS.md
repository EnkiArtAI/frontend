# Coordinator progress

Baseline note: the 2026-10-08 ClickUp bundle was checked against `main @ be6fe5e7`.
Repo owner confirmed 2026-10-09: **current `main` (`470739a`, 137 commits ahead of
be6fe5e7) is the new status quo.** A reconciliation pass is running to find which
"Missing" items in the bundle's task files are already covered by those 137
commits, before any task branch is opened, per rule 3.1 (verify before asserting)
and the mission statement (never rebuild work that already exists).

## Wave 0 (coordinator)
- [x] `.github/workflows/ci.yml` updated on branch `ci/setup`: push trigger on all
      branches (was `main`-only), added `concurrency` group per ref with
      `cancel-in-progress: true`. Jobs/scripts unchanged (already matched
      `package.json`: lint, check, test, build; already had an ephemeral Postgres
      service container and dummy build-time env — no secrets needed for CI to go
      green). Not yet pushed/PR'd — pending.
- [x] `docs/specs/BACKEND_BRIEF.md` written on `coord/progress`.
- [ ] `.env` secret provisioning: **blocked**. `gh repo view` shows
      `viewerPermission: WRITE`, `viewerCanAdminister: false` for the active
      account (rainman456). Setting repo-level Actions secrets normally requires
      admin. Flagged to the human; not attempted.
- [x] Task reconciliation vs current main: done, see `docs/specs/batches/batch-00-reconcile.md`.
      BAN marketplace lock dropped (already shipped in commits `ef009c5`/`49cf8d3`).
      REC-7 narrowed to stale-comment deletion + human CRON_SECRET confirmation.
      REC-1 narrowed to call-site wiring + payment_intent_id + imageId.
      ENV-01 narrowed to forgot-password honesty + generic provider 503 + tests.
      Everything else (REC-3, REC-8, BAN-8, MFA-1, MFA-3, MFA-4, all SOC, CDP-1)
      confirmed still fully open.
- [ ] Wave 1 agent assignments: updated, 3 agents not 4 (D dropped, its one
      remaining item folded into Agent B who already owns the file).

## Waves 1-4
Wave plan updated per reconciliation (see batch-00 doc). Not yet spawned —
waiting on human go-ahead given token cost of multiple parallel implementation
subagents.

## Blocked on human
1. Secret provisioning for CI (permission + which keys, see above).
2. Final go-ahead to spawn wave 1 subagents (now 3: A, B, C) with the narrowed scope.
