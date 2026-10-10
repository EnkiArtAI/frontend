# Handoff — Enki backend sprint, coordinator session ending

Written 2026-10-10 because the current session's weekly usage is near its cap and may
run out before more work can be reviewed. This is the single entry point for whoever
(human or another AI coding agent) picks this up next. Read this file fully before doing
anything else — it links to everything else you need and explains the mistakes already
made so you don't repeat them.

## -1. STOP AND READ FIRST: GitHub Actions is billing-blocked (as of 2026-10-10 ~13:59 UTC)

Every CI job on this repo (build/typecheck/lint/tests) now fails in 1-4 seconds with:
*"The job was not started because recent account payments have failed or your spending
limit needs to be increased. Please check the 'Billing & plans' section in your
settings."* Confirmed this is new (earlier runs the same day succeeded) and repo-wide,
not branch-specific. **Nothing will show a green CI run — for anyone, on any branch —
until a human fixes this in GitHub → Settings → Billing & plans.** This almost certainly
happened because wave 1's CI usage (8 PRs, many pushes, 2 independent-reviewer agents
reading diffs via `gh pr diff`, several multi-hour fix cycles with repeated pushes) used
up a spending limit or a payment method failed. There is nothing an agent can do about
this — it needs a human with org billing access. PR #173 (below) has code that was
proven red→green before this hit; don't assume its red CI status means the code is
broken — check whether the failure is this billing message before debugging anything.

## 0. What this project is

`EnkiArtAI/frontend` (GitHub, **private**) — a Next.js App Router app, TypeScript strict,
Supabase/PostgREST backend, Solana USDC payments via x402, deployed on Vercel, tested
with Vitest. A human named **Kev** owns CI/config/docs and merges everything; a
**Backend owner** and sometimes Kev jointly must approve money/security PRs
(`CONTRIBUTING.md` has the exact area ownership table). The GitHub CLI in this
environment is authenticated as **rainman456** with **WRITE** access (not admin — this
matters, see §6).

Two local directories matter:
- `C:\Users\USER\Documents\ENIKA\enki-main-upstream` — the actual git clone of
  `EnkiArtAI/frontend`. All code and PRs live here.
- `C:\Users\USER\Documents\ENIKA\enki-backend-open-oct09` — a **separate, non-git**
  folder with the Oct-9 ClickUp export: `AGENT_INSTRUCTIONS.md` (the authoritative,
  human-written process spec — read it in full, it overrides anything that conflicts
  with it below), `COMPLETED_CONTEXT.md` (what's already done, don't rebuild it), and
  `tasks/<CODE>.md` (one file per ClickUp task — descriptions plus dated comments,
  comments win over the description).

**`AGENT_INSTRUCTIONS.md` is the law.** It was revised once already, mid-session, by the
human to add an explicit "Execution model" line at the top: one coordinator + parallel
Sonnet subagents, CI-only verification, no local build/test ever. If it's revised again,
re-read it fully before continuing — don't assume you remember the current version.

## 1. What's done — Wave 1, complete, 8 PRs open

All CI-green (build/lint/typecheck/tests — the real gate; ignore 3 persistently-failing
Vercel preview-deploy checks, those are a pre-existing org/Hobby-plan limitation,
unrelated to any of this code).

| PR | Task | Branch | Base | Notes |
|---|---|---|---|---|
| [#162](https://github.com/EnkiArtAI/frontend/pull/162) | CI setup | `ci/setup` | `main` | Push-trigger on all branches + concurrency cancel |
| [#163](https://github.com/EnkiArtAI/frontend/pull/163) | REC-7 cleanup | `fix/rec-7-remove-stale-comment` | `ci/setup` | Trivial, stale comment only |
| [#164](https://github.com/EnkiArtAI/frontend/pull/164) | REC-1 (narrowed) | `feat/rec-1-payment-link-imageid` | `ci/setup` | Reviewed. Migration prepared, not applied |
| [#165](https://github.com/EnkiArtAI/frontend/pull/165) | MFA-1 | `feat/mfa-1-single-use-stepup` | `ci/setup` | Migration prepared, not applied |
| [#166](https://github.com/EnkiArtAI/frontend/pull/166) | BAN-8 | `feat/ban-8-withdraw-request-stepup` | `feat/mfa-1-single-use-stepup` (stacked) | **Reviewed, regression found and fixed — read batch-01.md before touching this PR** |
| [#167](https://github.com/EnkiArtAI/frontend/pull/167) | CDP-1 | `feat/cdp-1-upgrade-wallet` | `ci/setup` | 2 product decisions open, not implemented (correctly) |
| [#168](https://github.com/EnkiArtAI/frontend/pull/168) | REC-3 (narrowed) | `feat/rec-3-x402-recording` | `feat/rec-1-payment-link-imageid` (stacked) | Reviewed. Deliberately partial, see below |
| [#169](https://github.com/EnkiArtAI/frontend/pull/169) | SOC-8 | `feat/soc-8-betagate-whitelist` | `feat/cdp-1-upgrade-wallet` (stacked) | Fully done |
| [#173](https://github.com/EnkiArtAI/frontend/pull/173) | ENV-01 (forgot-password honesty, narrowed) | `fix/env-01-forgot-password-honesty` | `ci/setup` | Proved red→green on CI, then billing blocked (see §-1). Done directly by the coordinator, no subagent, no independent review. |

Full narrative detail, AC tables, and independent-review findings for each are in:
- `docs/specs/batches/batch-00-reconcile.md` — why the ClickUp baseline (be6fe5e7) was
  stale by 137 commits and how the real scope was re-derived from current `main`.
- `docs/specs/batches/batch-01.md` — MFA-1 + BAN-8, **includes a confirmed security
  regression and its fix** — read before merging #166.
- `docs/specs/batches/batch-03.md` — REC-7/REC-1/REC-3, includes two decisions (one now
  resolved, one still open).
- `docs/specs/batches/batch-06-cdp1-soc8.md` — CDP-1/SOC-8, includes two open product
  decisions. **Note the filename**: plain `batch-06.md` already existed in this repo's
  history from an unrelated 2026-09-27 sprint (ENG-11/ENC-6) — I clobbered it once by
  mistake and had to restore it. **Always check `git log origin/main -- docs/specs/batches/batch-NN.md`
  before writing a new batch file** — this bundle's batch numbers (01-09) collide with an
  earlier sprint's numbering.
- `docs/specs/PROGRESS.md` — the running coordinator log, rolls everything up.
- `docs/specs/BACKEND_BRIEF.md` — 300-word architecture brief originally written for
  subagents; still accurate, read it before exploring the codebase from scratch.

All of the above live on branch **`coord/progress`** (pushed to origin, never PR'd by
design — it's the coordinator's own scratch/log branch, not meant to merge).

## 2. Decisions and human steps outstanding (nobody should guess these)

1. **Secrets for CI**: blocked. `rainman456` has WRITE, not ADMIN; `gh secret set`
   needs admin. CI doesn't actually need secrets today (lint/typecheck/build/test all
   pass with mocks + dummy build env + an ephemeral Postgres container) — this only
   matters if a future task needs a real key in CI.
2. **Apply + read back 2 migrations**: `migrations/2026-10-09-consumed-stepup-tokens.sql`
   (MFA-1/BAN-8) and the REC-1 payment_intent_id migration (filename inside PR #164's
   diff). Both are additive, safe to run any time. A human runs them in the Supabase SQL
   editor, then reads the table back over PostgREST and pastes the column list into the
   relevant ClickUp task — per `CONTRIBUTING.md` §4, never skip the read-back.
3. **Confirm `CRON_SECRET` is set in Vercel Production** (REC-7) — can't be checked from
   the repo.
4. **Review BAN-8's scope reduction**: the original ticket asked for the step-up token to
   be bound to a server-issued *request id*; the shipped fix binds it to the withdrawal
   *destination address* instead (reverting to the pre-BAN-8 shape) plus single-use via
   MFA-1's consumed-token store. This was a deliberate, documented tradeoff (true
   request-id binding at `/build` has a chicken-and-egg problem — the row doesn't exist
   yet) that closes the security regression and the original replay concern, but is a
   smaller delivery than the ticket asked for. A human should explicitly accept or reject
   this before merging #166. Full writeup: `docs/specs/BAN-8.md` on branch
   `feat/ban-8-withdraw-request-stepup`.
5. **x402 unlinked-wallet recording policy** (REC-3, low urgency): should an x402 agent
   wallet with no linked Enki account ever get a `generations` row? Options a/b/c written
   up in batch-03.md. Current PR #168 does (a) — storage only, no row — which needs no
   new policy.
6. **CDP-1 Decision 1**: attach-wallet pre-claim verification, option a (CDP server-side
   lookup by `sub`) vs option b (keep collision-only check + alert cron). Agent recommends
   a. Full writeup: `docs/specs/CDP-1.md` on branch `feat/cdp-1-upgrade-wallet`.
7. **CDP-1 Decision 2**: recovery-file feature — rewrite around CDP's export iframe vs
   drop it and point users at the iframe directly. Agent recommends rewriting (option a).
   Also unresolved: CDP 0.0.127 added a distinct "eject" (full custody exit) action that
   wasn't investigated and might be a better fit than either option — worth 10 minutes on
   `docs.cdp.coinbase.com` before deciding.
8. **KEV-SOC** (unrelated to #4 above, don't confuse them): keep or park social login
   while signup is closed. Blocks Batches 07-09 entirely (all of SOC except SOC-1/2 which
   are also blocked — see §3). **Still fully open as of this session** — nobody has
   confirmed this one way or the other.
9. Register every Vercel preview domain in the CDP dashboard's allowlist (pre-existing,
   unrelated to this sprint's changes).

## 3. What's left — the backlog, in the batch plan's own order

Reconciled against current `main` (470739a) as of this session — confirm nothing has
moved further before resuming (`gh api repos/EnkiArtAI/frontend/compare/470739a...main`
is far cheaper than a local `git log` range on this clone, see §5).

- **Batch 02: MFA-3 + MFA-4** — depends on MFA-1 (#165, done, not yet merged — stack on
  `feat/mfa-1-single-use-stepup` per rule 4.11). Step-up on account/library delete
  (resource-bound scopes), opt-in step-up on `POST /api/prompt` + gallery upload. **Not
  started.**
- **Batch 04: REC-8** — storage policy (Cloudflare R2, public-unlisted, random
  unguessable keys, no listing). REC-7 (the other half of batch 04) is already done
  (confirmed in batch-00-reconcile.md and closed out via PR #163). Stack on
  `feat/rec-3-x402-recording`. **Not started.**
- **Batch 05: ENV-01 (narrowed)** — gallery-upload 503 already shipped (confirmed in
  batch-00-reconcile.md). Remaining: forgot-password must not silently swallow a mail
  failure in production (`app/api/auth/password/forgot/route.ts`, currently always
  returns `{ok:true}` and only logs to console when `NODE_ENV !== "production"`), a
  generic per-provider-key 503, one test per key class. **This is probably the single
  smallest remaining task** — likely doable directly without a subagent if you're
  working under a tight budget. BAN marketplace lock (the other half of original batch
  05) is **already done**, don't redo it (confirmed in batch-00-reconcile.md).
- **Batch 06: done** (CDP-1 + SOC-8, PRs #167/#169 above).
- **DECISION GATE before Batch 07**: KEV-SOC (§2 item 8). Everything below is blocked on
  this.
- **Batches 07-09**: all of SOC (SOC-1, SOC-2, SOC-3, SOC-4, SOC-5, SOC-7). Per
  `AGENT_INSTRUCTIONS.md` §7, this is a **port, not a rewrite** — the code already exists,
  built/tested/reviewed on 2026-09-24, on branches `be/SOC-oauth` and
  `fe/SOC-6-social-buttons` (both exist on origin, confirmed in the branch list). As of
  the Oct-8 status comment those branches were 457 commits behind main with 7 conflicting
  files — reconcile that gap before porting anything. Do not start until KEV-SOC says
  "keep."

## 4. How to run this if you're continuing with parallel subagents

Read `AGENT_INSTRUCTIONS.md` sections 3, 4, 4A, 4B, 5, 6, 7, 8, 9 in full — this summary
is not a substitute. The short version of what a coordinator does per wave:

1. Pick the next batch(es) from §3 above, respecting dependencies (stack on the
   dependency's branch, don't wait for it to merge).
2. For each task agent: give it (a) `BACKEND_BRIEF.md`, (b) only its own task's section
   of `AGENT_INSTRUCTIONS.md` plus the hard-safety-rules sections, (c) the specific
   `tasks/<CODE>.md` file path(s) to read itself, (d) any relevant `COMPLETED_CONTEXT.md`
   entries, (e) which files it exclusively owns this wave vs. must not touch, (f) branch
   names and base. Use `isolation: "worktree"` on the Agent tool call so parallel agents
   don't collide on git state in the same working directory.
3. Lifecycle per task: spec → red test → green implementation → refactor → mutation check
   (scratch `mut/<code>` branch, confirm CI goes red, delete the branch, never PR it) →
   deliver (PR, human merges, agent never does).
4. **Money/funds-path batches (currently: anything touching payments, withdrawals,
   step-up/MFA, x402) require a separate independent reviewer subagent** before the PR is
   called ready — give it ONLY the diff + the author's spec, not the author's context, and
   tell it explicitly to verify claims rather than trust them (see batch-01.md and
   batch-03.md for what this caught: a real security bypass, and a self-report that
   didn't match the actual diff).
5. After every PR: don't trust "CI green" + the agent's own report as sufficient. At
   minimum, `gh pr checks <n>` yourself and spot-check 2-3 of the agent's specific
   file:line claims directly.

## 5. Mistakes made this session — don't repeat them

- **This clone is shallow** (`--single-branch`, depth 1 originally, later only `main`'s
  full history was fetched via `--unshallow`... actually that was rejected for bandwidth —
  the clone still only has `main`'s ref tracked locally; other branches are fetched
  one-off into `FETCH_HEAD`, not persistent `origin/<branch>` refs). A plain
  `git log A..B` across branches often fails with "unknown revision." Prefer
  `gh api repos/EnkiArtAI/frontend/compare/A...B` (no local fetch needed, works
  regardless of clone depth) for anything historical.
- **`docs/specs/batches/batch-NN.md` filenames collide with an unrelated earlier sprint's
  numbering.** Always check `git log origin/main -- <path>` before writing one. I
  clobbered `batch-06.md` once (real, already-merged content from 2026-09-27) and had to
  restore it from commit `dd9dba8`. Consider renaming future reports
  `batch-NN-<task-codes>.md` to avoid this entirely (done for batch-06's actual report:
  `batch-06-cdp1-soc8.md`).
- **`rainman456` has WRITE, not ADMIN.** Don't attempt `gh secret set` or anything else
  requiring repo-admin without checking `gh repo view --json viewerCanAdminister` first.
- **A generic "Git Destructive" security-classifier warning fired for completely
  sanctioned behavior** (pushing then deleting a scratch `mut/<code>` branch; rebasing
  and force-pushing an agent's own unmerged branch — both explicitly required by the
  mutation-check lifecycle). Don't panic on this alone — but DO verify nothing *shared*
  was actually harmed: check `main`/`ci/setup`/`coord/progress` SHAs against what you last
  pushed, and confirm every open PR is still open (`gh pr list --state all`), before
  concluding it's a false positive.
- **Subagent self-reports can be wrong without any malice** — one agent claimed it
  modified a specific test file to fix a naming collision; the independent reviewer
  checked `gh pr diff --name-only` and that file wasn't in either PR. No functional harm
  resulted (CI was genuinely green on what was actually shipped), but don't take a
  "done/remaining" table at face value for anything that matters — spot-check the
  specific claims, especially file lists, on money-path work.
- **An independent reviewer checking "the whole repo" won't know to check the local
  task-bundle folder** (`enki-backend-open-oct09/`, outside the git repo) — one review
  flagged a cited Kev quote as "unverifiable, not in repo history" when it was real and
  verbatim, just in a folder the reviewer didn't know existed. Tell reviewers explicitly
  about that folder if their task might need it.
- **Background subagents sometimes report "completed" via the task-notification system
  several times in a row before actually delivering their SubagentHandback message** —
  this is normal (they have their own nested background work finishing up), not stuck.
  If it drags on past a couple of notifications, it's fine to verify independently
  (`gh pr view`/`gh pr checks` on whatever it's supposed to be doing) and, if the work
  looks done, send it a direct message asking it to stop and report immediately rather
  than keep waiting blind.
- **Session rate limits (5-hour window) can terminate a subagent mid-task.** Resuming via
  `SendMessage` to its agent id preserves its full context — just tell it to check its own
  `git status`/`git log` first and continue from there, not restart Phase 0.
- **Three worktrees from wave-1 agents are still on disk** (locked/unlocked, see below) —
  clean them up with `git worktree remove <path>` (add `--force` only if genuinely done
  with that agent) once their branches are confirmed pushed, to avoid confusing a future
  session:
  - `.claude/worktrees/agent-a1302bbaa29311686` → `feat/ban-8-withdraw-request-stepup` (locked)
  - `.claude/worktrees/agent-a4a6f5464a291e1a9` → `feat/rec-3-x402-recording`
  - `.claude/worktrees/agent-a515dee7e6472f91b` → `feat/soc-8-betagate-whitelist`

## 6. Credentials / access state

- `gh auth status`: authenticated as **rainman456**, WRITE access to
  `EnkiArtAI/frontend`, not admin.
- A real `.env` exists at `C:\Users\USER\Documents\ENIKA\.env` (outside the repo) — key
  **names only** have been read and documented (see `BACKEND_BRIEF.md`'s shared-files
  list and `.env.example`); no value has ever been printed, logged, or given to a
  subagent. Don't change that policy without the human explicitly asking again — they
  were asked and said to skip `gh secret set` for now.
- Local git identity was set repo-locally (not `--global`) to
  `simonlevi453@gmail.com` / `rainman456` for commit authorship on `coord/progress`.

## 7. If you're a fresh AI agent picking this up cold

Read, in this order: this file → `AGENT_INSTRUCTIONS.md` (full) → `COMPLETED_CONTEXT.md`
→ `BACKEND_BRIEF.md` → `PROGRESS.md` → the specific `batch-NN*.md` for whatever task
you're resuming. Then check `gh pr list --state all` and `gh pr checks <n>` yourself
before trusting any status written here — it was accurate as of 2026-10-10 but PRs may
have moved (merged, had review comments, hit CI drift) since.
