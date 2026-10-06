# Escrow program client

The Anchor interface in `idl/enki_escrow.json` is compiled from
`EnkiArtAI/enki-escrow`. `idl/provenance.json` identifies the source commit,
successful Actions run and artifact checksum. Codama generates the Kit client
in `generated/`; do not edit those files or hand-maintain a Borsh layout.

`npm run escrow:generate` regenerates the client. `npm run escrow:check` verifies
the IDL checksum and compares every generated file byte for byte. CI runs the
same check. To update the interface, first obtain the artifact from a successful
program build and verify its source commit and SHA-256, then update the IDL and
provenance together and regenerate.

The address embedded in the generated interface belongs to the local test
program. The application wrappers require an explicit server-configured program
address and cluster. No route uses the client yet, and this change does not
deploy a program or activate payments.

## Deposit integration contract

1. Authenticate the intent owner, apply limits and atomically reserve recovery.
   Read the program's configuration at confirmed commitment and validate it with
   `validateEscrowConfiguration`. Build a plan from stored server prices and the
   chain clock. Never accept amounts, recipients, network or program from a buyer.
2. Call `prepareEscrowDeposit` with a recent blockhash and its last valid block
   height. Persist the exact message, addresses, amount snapshot and lifetime
   before returning the unsigned wire. Neither buyer nor sponsor has signed it.
   Reuse that message until its blockhash expires rather than rebuilding it.
3. After the route wins its owned-intent transition to submitting, call
   `coSignEscrowDeposit` using the originally persisted message. It checks wire
   encoding, message equality and the buyer's Ed25519 signature before adding the
   sponsor's signature. Persist the signed wire and returned signature before
   simulation/broadcast; retries must recover or resubmit that same transaction.
4. After successful chain confirmation, fetch escrow and vault together with
   confirmed/finalized commitment and a context slot at least the confirmation's
   slot. Include the current chain clock from that response.
   `verifyFundedEscrow` validates immutable deposit fields, program owners,
   canonical addresses, state, unexpired lifetime and funds. Only then may the database mark the
   deposit funded and admit image claims. A client-supplied signature is not proof.

These pure helpers perform no RPC, database writes or paid API calls. The
generated settlement and reclaim builders share the same program interface;
delivered-image counting, retry persistence and atomic recovery booking belong
to the subsequent server lifecycle integration.
