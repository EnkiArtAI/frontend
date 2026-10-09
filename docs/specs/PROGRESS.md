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

## Wave 1 — spawned 2026-10-09, human go-ahead received
- Agent A: MFA-1 (`feat/mfa-1-single-use-stepup`) -> BAN-8 (`feat/ban-8-withdraw-request-stepup`, stacked). Money/funds path — needs an independent reviewer subagent before Phase 8 delivery per section 4B.4.
- Agent B: REC-7 stale-comment cleanup (`fix/rec-7-remove-stale-comment`, standalone) -> REC-1 narrowed (`feat/rec-1-payment-link-imageid`) -> REC-3 (`feat/rec-3-x402-recording`, stacked on REC-1). Money/funds path — needs an independent reviewer subagent before Phase 8 delivery.
- Agent C: CDP-1 (`feat/cdp-1-upgrade-wallet`) -> SOC-8 (`feat/soc-8-betagate-whitelist`, stacked). Not a money/funds path per 4B.4 — no dedicated reviewer required, coordinator spot-check on delivery is sufficient.
- Each runs in its own isolated git worktree to avoid branch collisions.
- Each was given the batch-00 reconciliation evidence directly (file:line) to skip re-deriving Phase 0.
- None of the three has real production credentials; all DB/schema evidence comes from `migrations/` and existing code, never a live probe — any live confirmation is a named human/coordinator step.

## Blocked on human
1. Secret provisioning for CI (permission + which keys, see above) — still unresolved.
2. After Agent A and Agent B each reach Phase 4 (green) on their money-path tasks (MFA-1/BAN-8, REC-1/REC-3), the coordinator will spawn an independent reviewer subagent per section 4B.4 before those PRs are called ready — not yet needed.
