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
  1. The durable-nonce authorize-then-capture reorder (the other half of REC-3's original
     scope) — the task file's comment thread has a 2026-09-24 note from Kev: "Claude stays
     off this path; coordinate through this task." The agent correctly treated this as a
     human-coordination gate, not a technical question, and did not touch the settlement
     order.
  2. "Record under the paying wallet" only happens when that wallet is already linked to
     an Enki account — `generations.user_id`/`generated_images.user_id` are `NOT NULL`
     FKs to `users.id`, and most x402 agent wallets have no linked account at all. Agent
     implemented the safe subset (record only when linked) rather than inventing a schema
     or identity policy.

## Decisions needed from the human (not guessed past, per rule 3.6/5)
1. **Coordination check**: has a human developer already started the x402 durable-nonce
   authorize-then-capture reorder? If yes, #168 should stay as-is until that lands and a
   future task finishes REC-3 on top of it. If no, someone needs to explicitly lift "Claude
   stays off this path" before any agent attempts it.
2. **Schema/identity policy**: should an x402 agent wallet with no linked Enki account ever
   get a `generations`/`generated_images` row? (a) leave as today — storage only, no
   gallery/share-preview row, what #168 does now; (b) auto-provision a lightweight `users`
   row on first payment from a new wallet; (c) relax the `user_id` FKs to nullable plus a
   `wallet_address` column for agent-owned rows. Agent's lean: (a), as the only option
   needing no new policy — (b)/(c) are real options if agent-generated images need to
   surface anywhere (gallery, share cards).

## Found on the way (not fixed, out of scope)
- `migrations/` has no file adding `generations.transaction_hash`/`chain_key`/
  `amount_paid_cents`, yet `lib/generation/record.ts` has written them since commit
  `6c63aa8` (2026-08-06) and 9 live rows already use them — a real gap in migration
  history (documentation only, not a live-schema risk since the columns demonstrably
  exist and are in active use).
- `gh pr edit` (GraphQL path) fails on this repo with a "Projects (classic) deprecated"
  error; worked around with `gh api .../pulls/N -X PATCH`. Noted for other agents.

## Independent review
Required per 4B.4 (money/funds path). Spawning now — will record the verdict here once
it reports, same as batch-01.
