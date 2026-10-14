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

## Wave 1 — COMPLETE (2026-10-10)
All 8 PRs open, CI-green, independent review done on both money paths (batches 01, 03).
Full detail in docs/specs/batches/batch-01.md, batch-03.md, batch-06-cdp1-soc8.md.

| PR | Task | Status |
|---|---|---|
| #162 | ci/setup | Open, green |
| #163 | REC-7 cleanup | Open, green |
| #164 | REC-1 (narrowed) | Open, green, reviewed |
| #165 | MFA-1 | Open, green |
| #166 | BAN-8 | Open, green, reviewed, revised after a confirmed security regression was caught and fixed |
| #167 | CDP-1 | Open, green |
| #168 | REC-3 (narrowed) | Open, green, reviewed |
| #169 | SOC-8 | Open, green |
| #173 | ENV-01 (forgot-password honesty, narrowed) | Open, proved red->green before CI got billing-blocked; done directly by the coordinator (no subagent), not reviewed by anyone else |

## CRITICAL — main merged 195 commits (PR #192, escrow/redesign cutover) while this
session was idle (2026-10-10 to 2026-10-14). Full reconciliation done 2026-10-14:
- `ci/setup` and 6 of 7 dependent branches (fix/rec-7-remove-stale-comment,
  feat/mfa-1-single-use-stepup, feat/ban-8-withdraw-request-stepup,
  feat/cdp-1-upgrade-wallet, feat/soc-8-betagate-whitelist,
  fix/env-01-forgot-password-honesty) merged current `main` in cleanly (no
  conflicts except a generated-lockfile conflict on CDP-1, resolved with a
  targeted `npm install --package-lock-only` per rule 4A.1 — see commit
  020471f for a loosened-pin regression that install caused and was then
  fixed). All pushed. REC-7's own change (a stale-comment deletion) turned
  out to be **fully superseded** — the escrow rewrite deleted the same code
  more thoroughly — so #163's diff against current `ci/setup` is now empty;
  recommend closing #163 as moot rather than merging a no-op.
- `feat/rec-1-payment-link-imageid` (#164) needed substantial manual
  reconciliation, not just conflict resolution: the escrow rewrite restructured
  the exact code REC-1 touched (payment-intent reading moved after auth, added
  an ownership check; `recordGeneration`'s error-handling model changed from
  REC-1's own alert-based design back to upstream's throw-based
  `requireAcceptedImage` gate, now load-bearing for escrow safety). Resolved by
  keeping the escrow throw-safety behavior and re-applying REC-1's actual
  additions (imageId capture, payment_intent_id/transactionHash/amountPaidCents
  wiring) on top of it, confirmed the `total_micro`/`tx_signature` columns are
  real via `migrations/generation_payment_intents.sql`, and fixed 2 further
  test files whose mocks assumed the old bare-string return type. **Verified:
  tests, build and typecheck all pass on the reconciled branch** — this was
  real, careful rework, not a guess. Full narrative in this file's git history
  (commit messages) and the diff itself.
- `feat/rec-3-x402-recording` (#168) merged the updated REC-1 branch cleanly,
  no conflicts (its target file, the x402 route, was untouched by the escrow
  cutover, as already established in batch-03.md).

## NEW CRITICAL BLOCKER — main's own CI has been red since the merge
Every one of the 9 PRs (162-169, 173) now fails the `lint` job identically:
`components/enki/EnkiFeedPage.tsx:71:13 error: Calling setState synchronously
within an effect can trigger cascading renders`. Confirmed via `main`'s own
CI run (38365847365, 2026-10-13) that this is pre-existing on `main` itself,
not introduced by anything in this bundle — nobody has fixed it since the
merge landed. `components/**` is Frontend-owned per CONTRIBUTING.md; this
coordinator has not touched it, pending the human's call on whether to fix it
(quick, likely a few lines) or leave it for the Frontend owner. **Every PR in
this bundle will show a red lint check until this is fixed on `main`, through
no fault of its own** — don't mistake this for a regression in any of our work.

## RESOLVED 2026-10-14 — GitHub Actions billing block (was: 2026-10-10, ~13:59 UTC)
Confirmed fixed: CI runs now take normal time (minutes, not seconds) and reach
real pass/fail results. Original note kept below for the record.

Every CI job (build/typecheck/lint/tests) now fails in ~1-4 seconds with:
"The job was not started because recent account payments have failed or your
spending limit needs to be increased. Please check the 'Billing & plans'
section in your settings." Confirmed this is new (runs earlier today
succeeded) and affects the whole repo, not one branch — nothing will show
green, for anyone, until a human fixes this in GitHub → Settings → Billing &
plans. **This likely means wave 1's CI usage (8 PRs, repeated pushes, 2
independent-reviewer agents reading diffs, several multi-hour fix cycles)
used up a spending limit or a payment method failed.** Not fixable from
here — needs GitHub org billing access.

PR #173 (ENV-01 forgot-password fix, see below) was opened with code that
proved red->green on CI before this hit; it's correct but can't show a green
run until billing is fixed.

## Session 2026-10-11 (fresh agent, handoff picked up)
- State verified: all 9 PRs still open (#162-169, #173); `main` identical to
  470739a (compare API, ahead_by 0). Nothing merged, nothing moved.
- **CI billing STILL blocked**: re-ran run 38058139337 (PR #173's branch) at
  2026-10-11 00:48 UTC — all 4 jobs failed in ~2s with the same billing
  annotation. Fresh evidence; still needs a human with org billing access.
- Housekeeping: the three wave-1 worktrees removed (branches verified pushed
  and matching origin first; all trees clean).
- Phase 0-2 prep done while CI is blocked (specs on this branch, status Draft):
  `MFA-3.md`, `MFA-4.md` (batch 02), `REC-8.md` (batch 04), `ENV-01.md`
  (batch 05 remainder). Test plans + ACs ready for Phase 3 the moment CI works.
- Key findings recorded in the specs:
  - MFA-3's lockout-guard ask (recovery clears factors) is superseded by a
    newer binding decision (Kev 2026-10-07, in
    `lib/__tests__/recovery-keeps-factors.test.ts`): recovery keeps factors.
    Report, don't fix.
  - Prompt delete still does not exist on main (`prompts/[id]` has GET+PATCH
    only) — the §5 open decision stands; out of scope.
  - PR #173's diff spot-checked by the coordinator (this session): 503 fires
    before the email lookup (no enumeration oracle), tests cover
    account/no-account/configured/dev-fallback. Still owes a Phase 6 mutation
    check once CI returns.
  - `chore/dev-env` (0299c6a) diffed: dev tooling only, nothing reusable for
    the ENV-01 remainder.
  - REC-8 upload-site inventory re-counted against main @ 470739a: the helper
    refactor means the "six put() calls" are now 3 modules (derivative-store,
    reference-images, gallery/upload) + the db-health cron marker (infra,
    stays). PR #168 does not touch derivative-store.ts — no conflict.
- Batch 02/04/05 implementation is READY but STARTs ONLY after CI billing is
  fixed (lifecycle Phases 3/4/6 need CI run ids; there is no local testing).

## Blocked on human
0. **Fix GitHub Actions billing (see above) — blocks literally everything else.**
1. Secret provisioning for CI (permission + which keys) — still unresolved, rainman456 lacks admin.
2. Apply + read back: consumed-stepup-tokens migration (MFA-1/BAN-8), generations.payment_intent_id migration (REC-1), confirm CRON_SECRET in Vercel Production (REC-7).
3. Review BAN-8's destination-bound-vs-request-id-bound scope reduction (batch-01.md).
4. Decision: x402 agent-wallet recording policy when unlinked (batch-03.md, low urgency).
5. CDP-1 Decisions 1 and 2: attach-wallet pre-claim verification option a/b, recovery-file rewrite vs replace (batch-06-cdp1-soc8.md).
6. Register Vercel preview domains in the CDP allowlist.
7. Decide wave 2 go-ahead — weekly usage was at 73% mid-wave-1; recommend checking current usage before committing to another wave of parallel agents.
