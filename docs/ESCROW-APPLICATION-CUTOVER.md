# Escrow application cutover — local implementation, 2026-10-12

The browser payment path now prepares one escrow for the paid images of one click. The buyer signs the server-compiled message, the operator co-signs only that same message, and generation starts after both canonical funded accounts are verified. Config.max_deposit_micro is the only deposit cap. The server never invents another cap or recalculates recovery outside the reservation RPC.

The application free allowance is one image per UTC day on the existing free baseline model. Premium catalogue models remain paid even if an old pricing_rules free_generation campaign is still present. Fee discounts remain supported. A batch exceeding the free allowance requires explicit selection of a compatible paid model and a displayed server-priced total. The free baseline has no invented paid price or silent substitution.

## Local modules and contracts

- `lib/payments/escrow/server-deposit.ts`: prepare, exact-message buyer verification, submission lease, persist-before-broadcast, immutable deposit retry and finalized absence/height proof for expiration.
- `server-claims.ts`: one provider invocation per unit, authenticated ownership and actual users.id, fresh funded proof, immutable matching claim token, accepted durable-image delivery and SQL-only frozen delivered count.
- `server-lifecycle.ts`: separately stored settlement and reclaim attempts; a retry broadcasts the winning persisted wire. Successful settlement needs its receipt and matching settled escrow/vault. Reclaim confirmation needs its receipt and absence of both canonical PDAs at or beyond that receipt. Expiry uses block height from the same finalized bank as its account proof. RPC failure and wall time are never expiry proof.
- `server-sweep.ts` and the existing five-minute cron: bounded reconciliation of open orders, including funded orders abandoned before generation. Closed history is excluded from candidates and checked timestamps rotate the scan so blocked old orders cannot starve new work. Never-persisted expired reservations are released under the same intent and artist/mint locks; any persisted deposit still requires chain proof. Stable server monitoring labels identify count/account discrepancies without logging credentials or upstream error objects.
- `POST /api/payments/generation/authorize`: `{intentId,units}` returns the unsigned escrow deposit.
- `POST /api/payments/generation/submit`: `{intentId,signedTransaction}` returns `{state,funded,paymentScheme:"escrow"}`. An uncertain submission remains pending.
- `GET /api/payments/generation/status?intentId=...`: owned deposit status, batch progress and unit states; a durable delivered image can be recovered without replaying its provider call.
- `POST /api/payments/generation/cancel`: stop unstarted units while in-flight leases may finish; separately settle delivered work and refund unused funds.
- `POST /api/generate-image`: `{intentId,unitIndex,content...}`; prices/model/quality/boost come from the stored intent. Core generation and accepted image records are awaited before delivery is counted. A lost delivery acknowledgement is retried idempotently and may return a saved image with reconciliationPending.
- `GET /api/generate-free/quota`: authenticated database-day allowance, private/no-store. Admission remains atomic in the generation route; the GET is informational.

Settlement never depends on an off-chain artist-ATA check, and never bundles artist ATA creation or reclaim. An unusable artist ATA only forfeits the artist leg; the treasury leg still settles. Dust does not create a refund obligation.

The existing external x402 `exact` endpoint retains its standard direct-transfer behavior. It is not a fallback for this browser escrow checkout, and it must not be advertised as escrow or mapped to a custom Anchor Deposit while retaining the standard `exact` scheme. Its eventual escrow protocol is a separate integration decision. Its current code does not write the recovery ledger, so it does not participate in the old capture/reservation race.

## Deployment sequence and owner work

1. Stop all old nonce admissions. Keep the previous release available for draining and reconciliation. Wait for running generation requests to finish; a durable nonce signature does not expire just because time passes.
2. Verify old signed transactions and nonce accounts on chain, and reconcile captured-but-unconfirmed or unbooked ledger entries. A sweep returning zero is insufficient, because the previous sweep skips captured rows. Close unused nonce accounts and retain an audit of any old account rent or ledger repair.
3. Apply the reviewed recovery and deposit migrations (`2026-10-05-escrow-recovery-reservations.sql`, `2026-10-06-escrow-deposit-persistence.sql`) if absent, then run `2026-10-12-escrow-cutover-guard.sql` during the maintenance window. It fails on visible unresolved legacy payments; it cannot itself prove on-chain closure or successful historical ledger booking.
4. Apply the unit-claim and settlement-attempt migrations, followed by `2026-10-12-escrow-orphan-reservations.sql` and `2026-10-12-free-daily-quota.sql`. Deploy application code only together with the new quota RPC. The SQL contracts are service-only, use fixed search paths and account/payment locks, and deny direct client writes.
5. Complete the separate program release first: authoritative devnet/mainnet program IDs, Anchor keys sync and re-pinned frontend IDL, mainnet feature build, and the reviewed guardian/operator update behavior. Configure the application's explicit Solana payment cluster, deployed escrow program ID and operator signer; check real on-chain Config and treasury ATA. No default chain or guessed program key is accepted.
6. Review CODEOWNERS: `@TODO-backend` is still a placeholder. A real backend reviewer must own the money, migration, generation and cron changes. Listing two owners in CODEOWNERS requires either one's approval, not both; enforce the agreed backend approval plus Kev's merge through repository rules/process.
7. Run the local checks and real multi-session PostgreSQL contention job. Then obtain a specific test authorization with network, wallet, planned image count/model and maximum API cost before a genuine provider/deposit/settle/reclaim acceptance run. This local work has not activated live funds, paid generation or database migrations.

After operator rotation, the old rent-payer signing capability must remain available until its open escrows close. The current operator can settle, but recreating a missing buyer ATA during reclaim requires the original rent payer's signature. Treasury ATAs must stay usable while their escrows remain open.

A successful settlement whose canonical account is externally reclaimed before its database proof is captured is reported for reconciliation, rather than guessed from an unavailable account. The known signed receipt and persisted wire remain audit material. Monitoring must alert on these cases and on any difference between settled_units and the delivered-unit ledger.

## Validation limits

Deterministic tests use generated/independent Anchor and SPL layouts, real local transaction signatures, simulated RPC/database boundaries and offline PostgreSQL via PGlite. The live REST schema was read for exposed columns; no live SQL write, funded transaction or provider generation was performed. New application SQL must still be reviewed against the deployment's complete constraints and indexes. Local fixture tests do not prove cross-process PostgreSQL contention. Rust program builds remain paused pending resolution of the Norton report.

## Completed local verification (2026-10-12)

- Frontend: 3,103 tests passed across 267 files; backend: 3 tests passed.
- SQL: 70 offline checks passed (48 escrow, 11 daily quota, 11 legacy cutover guard). These run in PGlite; the real multi-session PostgreSQL job remains a deployment check.
- Full TypeScript check passed with incremental caching disabled.
- Source ESLint passed with zero errors and 117 existing warnings. The command excluded local generated preview builds and tooling: `node node_modules/eslint/bin/eslint.js . --ignore-pattern '.next*/**' --ignore-pattern '.tooling/**' --ignore-pattern 'output/**' --pass-on-unpruned-suppressions`. Default lint also scans custom local preview build directories, so it was not used as the final source check.
- The webpack production build passed; `npm run escrow:check` verified 27 generated interface files against the compiled Anchor interface.
- Browser fixtures passed at 1440×900 and 390×844. A four-image order displays one free image and three paid images, requires an explicit paid model choice and displays the simulated server total before enabling confirmation. Editor and image view show available and exhausted quotas. One simulated free request consumed the quota; a second attempt made no generation request.
- Browser audit: zero paid submissions and zero unmocked API calls. Six external font requests were blocked. Fixture prices and images are examples, not live provider prices or funded acceptance results.

All changes and verification results remain local. No remote push, GitHub CI rerun, live database migration, funded transaction, or paid provider generation was performed.
