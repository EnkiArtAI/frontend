# Escrow deposit persistence

ClickUp `123qmzqzw1w`. Apply `2026-10-05-escrow-recovery-reservations.sql`
before `2026-10-06-escrow-deposit-persistence.sql`. Both are additive and
idempotent. Neither migration activates an application route. Existing payment
columns, status constraints and rows are retained.

The second migration stores one immutable deposit per reserved intent in
`generation_escrow_deposits`. The exact unsigned wire, message bytes, blockhash,
last valid block height, chain clock, expiry, program, cluster, buyer, sponsor,
treasury and canonical escrow/vault addresses survive a server restart. Units,
mint and the two per-image amounts remain in the immutable recovery snapshot
from the first migration. Combine both records to reconstruct the SDK plan.

The database stores transaction bytes as `bytea`; PostgREST accepts their hex
representation (`\x` followed by hex digits). Convert the SDK's canonical
base64 with `Buffer.from(value, 'base64')` and persist its hex bytes. When reading,
convert the returned hex to bytes and canonical base64. Never rebuild an
already prepared message from a new quote or blockhash.

## Transitions

| RPC | Transition | Contract |
| --- | --- | --- |
| `prepare_generation_escrow_deposit` | absent → prepared | Lock the owned intent, require its unchanged open recovery snapshot, persist before responding. A racing/repeated preparation returns the first stored record including terminal states. |
| `begin_generation_escrow_submit` | prepared → submitting | Supply a fresh server-generated UUID token and the current chain block height. Exactly one request receives a row. Other requests receive an empty result, even with the same token. |
| `store_generation_escrow_signed_deposit` | submitting → submitted | Require the winner's token, both signature slots and the original message. Persist signed bytes and their signature before any simulation or broadcast. An identical retry returns the original record; a replacement fails. |
| `confirm_generation_escrow_deposit` | submitted → funded | Require the persisted signature and a positive confirmation slot. Atomically mark the deposit and parent intent confirmed. Repeated confirmation returns the original slot/timestamp. |
| `expire_unfunded_generation_escrow_deposit` | prepared/submitting/submitted → expired | Require finalized block-height expiry and the slot of the verified absence read. Atomically expire both rows and release the recovery reservation. Retain signed bytes/signature for audit. |

Every RPC receives `p_intent_id` and `p_owner_wallet`, matched exactly against
the stored intent's owner. That owner is the authenticated session's stored
identifier. It is distinct from the case-exact Solana `buyer_address`; resolve
that address from the user's registered wallet before preparing the transaction.
Never lowercase a Solana public key for a signature or PDA calculation.

All transitions lock the intent before the deposit. Recovery release subsequently
takes the same artist/mint advisory lock as the recovery migration. No database
lock spans a network request. `anon` and `authenticated` have neither table access
nor RPC execution. `service_role` can select deposits and execute the five RPCs;
it cannot insert, update or delete deposit rows directly. RLS remains enabled;
the functions fix `search_path` to `pg_catalog` and qualify application relations.

## Application proof requirements

These RPCs cannot verify Solana. Only the trusted backend may call them, after
performing the appropriate SDK/RPC checks:

1. Preparation validates the deployed program/configuration, canonical addresses,
   amounts from the recovery snapshot and the case-exact wallet. The wire is the
   SDK's unsigned legacy transaction with two empty signature slots. SQL checks
   the byte boundary, message equality and size; it does not decode instructions.
2. Submission validates the buyer's Ed25519 signature and exact original message,
   checks block-height lifetime, then acquires the transition. The winner calls
   the SDK's `coSignEscrowDeposit`. The sponsor signs last. Only a successfully
   persisted signed transaction may be simulated or sent.
3. A retry reads the stored transaction first. It checks for a landed signature
   and resends only the same bytes while the blockhash remains valid. It never
   replaces the original blockhash, signs a second message or takes over a
   `submitting` token. A crash before signed-wire persistence is recovered by
   proving the deposit absent after block-height expiry.
4. Funding requires successful confirmed/finalized signature status and
   `verifyFundedEscrow` for escrow and vault read together at a context slot at
   least the deposit confirmation slot, including the current chain clock.
   A supplied signature string or processed status alone is insufficient.
5. Unfunded expiry first checks signature history and both canonical accounts at
   a finalized bank after the stored last valid block height. Persist that bank's
   height and absence-read slot. An unavailable RPC, elapsed quote TTL or missing
   recent status result is insufficient. A discovered funded escrow follows
   settlement/reclaim; its debt reservation cannot be released as absent.

The database's `confirmed` parent status must be routed through escrow's funded
marker and per-image claims in the application cutover. The legacy one-shot
prepaid claimant is insufficient. Deploy these RPCs before that coordinated
cutover; do not invoke them from the existing nonce handlers. Stop accepting new
nonce payments and drain pending legacy recoveries before activating escrow,
because the old ledger writer does not share the reservation lock.

## Verification and deployment

`npm run test:migrations` applies both migrations twice against the schema
fixture and executes their permission, transition, persistence and rollback
checks with an isolated in-memory PostgreSQL runtime. The same command with
`--postgres` additionally observes real blocked PostgreSQL sessions for recovery,
preparation and submit races. CI restricts that connection to its disposable
loopback-only `enki_escrow_test` database. It never loads production credentials.

On 2026-10-06, a fresh read-only live probe confirmed the fixture's 47 columns,
18 constraints and nine indexes for intents and the artist ledger. The deposit
and recovery tables are new migration-owned schema. No production migration was
applied during implementation. After Kev approves deployment, read the added
table metadata back through PostgREST and record it in the task as required by
`CONTRIBUTING.md`.

Reverting the application change stops new calls; keep the additive tables and
transaction audit while payments drain. Do not drop a table containing a funded
escrow or discard a persisted signature as part of a code rollback.
