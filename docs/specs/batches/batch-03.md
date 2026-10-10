# Batch 03: REC-7 cleanup + REC-1 (narrowed) + REC-3 (narrowed)

Baseline: main @ 470739a   PRs: #163 (REC-7 cleanup), #164 (REC-1), #168 (REC-3, stacked on #164)

## Done / Remaining
- #163: stale "no scheduler" comment deleted, no behavior change. CI green. Human step:
  confirm `CRON_SECRET` set in Vercel Production (unverifiable from repo).
- #164 (REC-1): `payment_intent_id` added end to end (migration prepared, not applied),
  `transactionHash`/`amountPaidCents` wired at the generate-image call site, `imageId`
  returned in the response, derivative/reference uploads moved off the pre-response path.
  All 4 ACs pass with evidence; mutation check confirmed the admin-alert-on-recording-
  failure line is load-bearing. CI green. Human step: run the prepared migration.
- #168 (REC-3): storage now uses the real payer wallet and MIME-from-bytes (both pass).
  Two items explicitly **not implemented, stopped rather than guessed**:
  1. The durable-nonce authorize-then-capture reorder — **RESOLVED, see below.**
  2. "Record under the paying wallet" only when that wallet is already linked to an Enki
     account (`generations.user_id`/`generated_images.user_id` are `NOT NULL` FKs). Agent
     implemented the safe subset rather than inventing a schema/identity policy.

## Decision 1 — RESOLVED (was open, coordinator verified 2026-10-10)
Agent B's PR body cited a quote from `tasks/REC-3.md` (outside the git repo, in the local
task bundle) attributed to Kev, 2026-09-24: *"confirmed solid, his developer is already
working on it. Claude stays off this path; coordinate through this task."* The independent
reviewer (below) flagged this as unverifiable because it only checked the git repo, not
the local bundle directory. The coordinator confirmed the quote is real and verbatim in
`C:\Users\USER\Documents\ENIKA\enki-backend-open-oct09\tasks\REC-3.md:30`. **This confirms
a human developer is already working on the settlement reorder** — no action needed, no
question for the human. REC-3's remaining scope (the reorder) stays with that developer;
a future task finishes REC-3 on top of their work once it lands.

## Decision 2 — still open
Should an x402 agent wallet with no linked Enki account ever get a `generations`/
`generated_images` row? (a) leave as today — storage only, what #168 does now; (b)
auto-provision a lightweight `users` row on first payment; (c) relax the `user_id` FKs to
nullable plus a `wallet_address` column. Agent's lean: (a). Only matters if agent-generated
images need to surface anywhere (gallery, share cards).

## Independent review (money/funds path, per 4B.4) — 2026-10-10
1. **Migration safety — confirmed fine.** `migrations/2026-10-09-generations-payment-intent-id.sql`
   is purely additive (`ADD COLUMN IF NOT EXISTS`, nullable, no default, re-runnable), matches
   the only write site (`lib/generation/record.ts:235`) and the route's string `intentId`.
2. **"Tests fixed, not weakened" — mostly confirmed, one note, one discrepancy.**
   `durable-store.test.ts` and `paid-model-selection.test.ts` changes preserve original intent.
   `image-check-wiring-x402.test.ts:45` genuinely loosens a strict adjacency regex, but the
   reviewer traced the author's rationale (the new non-blocking `after()` recording block
   can't gate delivery by construction) and judged it a reasonable loosening, independently
   backed by a separate test (`x402-records-image.test.ts`), not a sneaky one.
   **Discrepancy: the agent's own report claimed it modified `lib/__tests__/no-guessed-model.test.ts`
   to fix a banned-model-id string collision. Coordinator confirmed via `gh pr diff --name-only`
   that this file is in neither PR #164 nor #168's diff.** The claim does not match what was
   actually shipped. No functional impact found (CI is genuinely green on the actual diffs),
   but it's a real self-report accuracy gap, not just a reviewer blind spot — noted for the
   record, not re-opening the agent over it unless something else surfaces.
3. **Recording-failure-never-blocks-payment — confirmed for correctness, new latency flag.**
   `recordGeneration`'s try/catch always returns null/partial, never throws, so a DB error
   can't 500 a paid response. But #164 moved the three inserts from `after()` to **awaited,
   pre-response**, with no timeout/AbortSignal on the Supabase client — a slow/hung DB call
   now adds unbounded latency to an already-paid response, a real availability-risk regression
   the PR's "bounded, single-row inserts" framing understates. Not a correctness bug. Worth a
   follow-up ticket (add a timeout), not a blocker.
4. **`NOT NULL` FK claim — plausible, not independently confirmable from the repo.** No
   migration file creates/alters `generations`/`generated_images` (consistent with them
   predating the migrations folder). Sibling tables and `GenerationRecord.userId`'s
   non-nullable type are consistent with the claim. Flagged to the human merger as
   "author-asserted, not repo-verified" — matters only if Decision 2 above gets picked.
5. **x402 fail-closed basics — confirmed fine.** The `after()` recording block never gates
   settlement or delivery either way.

## Found on the way (not fixed, out of scope)
- `migrations/` has no file adding `generations.transaction_hash`/`chain_key`/
  `amount_paid_cents`, yet `lib/generation/record.ts` has written them since commit
  `6c63aa8` and 9 live rows already use them — documentation gap only, columns demonstrably
  exist and are in active use.
- `gh pr edit` (GraphQL path) fails on this repo ("Projects (classic) deprecated"); use
  `gh api .../pulls/N -X PATCH` instead.

## Verdict
#163 and #164 are ready for human merge (human steps: confirm `CRON_SECRET`, run the
migration). #168 ships its safe subset correctly scoped; full REC-3 is blocked on the
human developer's settlement-reorder work landing first, which is expected and correct,
not a gap to chase.
