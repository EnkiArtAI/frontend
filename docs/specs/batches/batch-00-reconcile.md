# Batch 00: reconcile bundle against current main

Baseline in bundle: `be6fe5e7`. Current `main`: `470739a` (137 commits ahead, 0 behind).
Repo owner: "main is now the status quo" (2026-10-09) — treat `470739a` as baseline,
not `be6fe5e7`. Verified by a read-only discovery agent against the current working
tree, spot-checked by the coordinator on 3 claims (all held):
- `lib/payments/generation-quote.ts:144-146` — `hiddenOwners` check, confirmed.
- `lib/generation/record.ts:176,178` — `transaction_hash`/`amount_paid_cents` columns exist, confirmed.
- `components/BetaGate.tsx:21` — `BETA_ROLES` still hardcoded, no whitelist-stage-unset branch, confirmed.

## Verdicts

| Task | Verdict | Evidence | Action |
|---|---|---|---|
| BAN parent (marketplace lock) | **Done** | `lib/hidden-owners.ts` wired into all public reads (commits `ef009c5`, `49cf8d3`); both quote (`generation-quote.ts:144-146`) and x402 sale paths refuse via the same `computeQuote`; funds routes untouched | **Drop from wave plan** |
| REC-7 | **Mostly done** | `app/api/cron/sweep-payments`, `lib/cron.ts:13-22`, `vercel.json:5` all present and correct (200/401/503 as specced) | **Narrow**: only the stale comment at `generate-image/route.ts:159-163` remains (Agent B deletes it, already owns the file) + human CRON_SECRET confirmation. No separate wave-1 agent needed. |
| REC-1 | **Partial** | `record.ts` has the DB columns; `generate-image/route.ts:880-921` call site never passes `transactionHash`/`amountPaidCents`; `payment_intent_id` doesn't exist anywhere; no `imageId` in response | **Narrow**: wire call site + add `payment_intent_id` (schema+code) + add `imageId` to response. Scope is smaller than the task file implies. |
| ENV-01 | **Partial** | `app/api/gallery/upload/route.ts:130` already answers 503 for missing blob token | **Narrow**: remaining scope is forgot-password mail-failure honesty, generic per-provider 503, and the one-test-per-key-class requirement. |
| REC-3, REC-8, BAN-8, MFA-1, MFA-3, MFA-4, SOC-1/2/3/4/5/7/8, CDP-1 | **Still fully open** | Confirmed no relevant change in the 137 commits (grep/line checks in subagent report) | Keep as-is, per original batch plan. |

## Wave plan change
- **Wave 1** shrinks from 4 agents to 3: drop Agent D (REC-7 cron route — already done). Agent B's Batch 03 task note updated to include deleting the stale comment (already in scope per original plan) and the narrowed REC-1.
- **Wave 3** shrinks from 2 agents to 1: drop Agent E (BAN marketplace lock — already done). Agent F (ENV-01) keeps its narrowed scope.
- Net: 3 fewer agent-tasks than originally planned (D, E dropped; REC-1/ENV-01 scope reduced), before any implementation work starts.
