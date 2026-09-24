# Contributing to Enki Art

One repo, several people. These rules exist so nobody breaks someone else's
area and every change can be undone with one clean revert. Read once, then
follow. Questions go to Kev in ClickUp, not into a PR description.

## 1. Areas and owners

Ownership decides who reviews. Anyone may open a PR anywhere; the owner of the
area must approve before Kev merges. `.github/CODEOWNERS` enforces the review
request automatically once branch protection is on.

| Area | Paths | Owner (review) |
| --- | --- | --- |
| Backend | `app/api/**`, `lib/**` except the UI helpers listed under Frontend, `migrations/**`, `backend/**`, `proxy.ts`, `shared/**` | Backend owner (see roster) |
| Frontend | `components/**`, `hooks/**`, `providers/**`, `app/**/page.tsx`, `app/**/layout.tsx`, `app/**/*.css`, `public/**`, `lib/editor/**`, `lib/enkiPromptAdapter.ts`, `lib/variableColors.ts`, `lib/promptTextareaCaret.ts` | Frontend owner (see roster) |
| Money and security | `lib/payments/**`, `app/api/payments/**`, `app/api/x402/**`, `app/api/auth/**`, `lib/webauthn.ts`, `lib/crypto.ts`, `lib/wallet-jwt.ts`, `lib/allowlist.ts`, `lib/session-user.ts`, `lib/auth.ts`, `lib/moderation/**`, `lib/moderation-enforcement.ts`, `proxy.ts` | Backend owner **and** Kev, both approvals |
| Config, CI, docs | `package.json`, `tsconfig*.json`, `next.config.*`, `vercel.json`, `eslint.config.*`, `vitest*.ts`, `.github/**`, `*.md`, `docs/**`, `scripts/**` | Kev |

Roster (who fills the owner roles) lives at the top of `.github/CODEOWNERS`.
When the team changes, change that file, nothing else.

## 2. Branches

- Base every branch on `main`. Until the `feat/generation-core` merge lands
  (ClickUp ENG-15) base on `feat/generation-core` and say so in the PR.
- Name: `<area>/<ticket>-<slug>`, for example `be/ENG-01-x402-model`,
  `fe/FE-03-notifications`, `docs/PRO-01-contributing`.
- Never push to, rebase or force-push someone else's branch. Comment on the PR
  instead.
- No force-push on any shared branch. If you must rewrite history on your own
  branch, say so in the PR before you do it.

## 3. Pull requests

- **One concern per PR.** A refactor and a behaviour change are two PRs. A
  backend change and a UI change are two PRs, even when the feature needs both.
- **Small.** If the diff needs a scroll bar to review, split it.
- **Title** starts with the ticket: `ENG-04: balance lookup applies the mainnet
  RPC override on mainnet only`.
- **Body** answers three questions: what changed, how you proved it works,
  what a reviewer should click through. Paste the test output, not "tests pass".
- **CI must be green** (lint, typecheck, tests, build). Never `--passWithNoTests`,
  never skip a test to make it green. A flaky test gets `.skip` plus a ticket.
- Rebase on the base branch before requesting review. Resolve every review
  thread with a commit or a reply, never by clicking resolve alone.
- Kev merges. Merge commit for feature branches (history stays intact).
- **Revertible:** every PR must be undoable with a single `git revert` of its
  merge commit. If yours is not, it is too big.

## 4. Database

- **Never derive a table or column name from app code.** Probe the live
  database first (PostgREST with the service key read into a header, never
  printed). Columns and constraints. Then write the code.
- A migration is its own PR under `migrations/`, dated, idempotent, additive
  where possible. After it runs, read the table back over PostgREST and paste
  the column list into the ClickUp task.
- Rows that change behaviour (routing, prices) are patched by the backend owner
  only, after a fresh probe, and read back afterwards.

## 5. Secrets and money

- **Never print a secret.** Not a value, not a prefix, not a length. To check
  that a key is configured, print a boolean. No `console.log(process.env)`,
  no `cat .env*`, no `curl -v`. `SECRETS.md` has the incident.
- **Every metered API call in development costs money.** Before the first call
  write in the ticket: how many calls, which provider and model, the estimated
  cost, and what question it answers. Wait for Kev's go. Run through
  `scripts/metered-guard.mjs`. Never send a large number to probe a limit; send
  a wrong type.
- Live API tests are named `*.live.test.ts`, `__live-*` or `__bench-*`. They
  are gitignored and excluded from vitest, so `npm test` and CI can never bill.
- **Customer price = real API cost plus exactly 10 percent.** One source for
  prices (catalogue and database). A paid request never falls back to a
  guessed model.

## 6. Tests

- New behaviour comes with a test that fails without the change. Prove it:
  revert the one line, run the test, watch it go red, put the line back.
- Tests never touch the network or the clock. `vitest.setup.ts` throws on an
  unmocked `fetch`.
- Money math, moderation, auth gates and routing always get tests. UI gets a
  browser check on the preview deployment with a screenshot in the PR.

## 7. Code style

- The least code that solves it well. No speculative abstractions, no dead
  flags, no boilerplate, no TODO comments (open a ticket).
- TypeScript strict. No `any` without a comment saying why.
- User facing copy: honest states for guests, no fake balances or badges,
  prices only on open panels, no dashes as punctuation.

## 8. Local setup

```bash
git clone https://github.com/EnkiArtAI/frontend.git
cd frontend
npm ci
cp .env.example .env.local   # ask Kev for the values, never paste them into chat or tickets
npm run dev -- -p 3008       # http://localhost:3008 (the dev script sets no port; the app's defaults assume 3008)
npm run check                # typecheck
npm test                     # vitest, lib/** suites
npm run lint
```

## 9. Where things are

- Generation: one core, `hooks/useGenerationCore.ts`, feeds every generate
  surface. Do not add a second generate path.
- Paid path: `app/api/payments/generation/*` (quote, intent, authorize,
  submit) then `app/api/generate-image`. Agents: `app/api/x402/generate`.
- Auth: `app/api/auth/**`, sessions in `auth_sessions`, passkey step up in
  `lib/webauthn.ts`, beta allowlist in `lib/allowlist.ts` and `proxy.ts`.
- Dead code you must not build on: see ClickUp list "Do not build". The
  Express server under `backend/` is not deployed and is being deleted.
