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

1. Authenticate the intent owner. Read the deployed program's current Config at
   confirmed commitment and validate it with `validateEscrowConfiguration` using
   the server quote and chain clock. The quote's signing rent payer must match the current
   `Config.operator`; `validateEscrowConfiguration` enforces this binding before
   a deposit is prepared. Admin/upgrade governance is separate from this signer.
   Pass its verified `maxDepositMicro` to the
   reservation RPC as required `p_max_deposit_micro`. Build the deposit plan from
   the returned row's net treasury/artist legs and `recovery_unit_micro`, then
   validate the updated plan against that Config. Supply its cap explicitly to
   `prepareEscrowDeposit`; no default or independent 25/50-USDC limit exists.
   Never accept amounts, caps, recipients, network or program from a buyer.
   Section 7 is calculated only in the RPC, with half the artist share per unit
   until unreserved rent debt is repaid, without an instalment ceiling.
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
   canonical addresses, state, unexpired lifetime and funds. The funded account's
   `refundDue` must equal the quoted total. Donated vault tokens do not increase
   that claim or purchase additional units. Only then may the database mark the
   deposit funded and admit image claims. A client-supplied signature is not proof.
   Generation admission must also check that the remaining chain TTL covers its
   generation budget; a funded, merely unexpired escrow is not sufficient.
   This verification takes the immutable `EscrowPaymentSnapshot`, without a
   current cap: changing Config after funding cannot invalidate the payment or
   block settlement/refund. New deposits require `EscrowDepositPlan`, including
   the verified current cap. Caps beyond JavaScript's safe integer representation
   fail closed; that numeric boundary is not a second payment policy.

These pure helpers perform no RPC, database writes or paid API calls. The
generated settlement and reclaim builders share the same program interface;
delivered-image counting, retry persistence and atomic recovery booking belong
to the subsequent server lifecycle integration.

## Settlement and reclaim integration contract

- Persist the count of delivered images in the database and use that count as
  settlement `k`. Never take it from a request. A reconciliation job must compare
  on-chain `settled_units` with delivered rows and alert on any mismatch.
- Send settlement regardless of the artist ATA's state. Do not gate settlement
  on an off-chain `getAccount` result; the program handles an unusable artist ATA
  by returning only that leg to the buyer while paying the treasury.
- Send settlement as its own transaction. Never bundle it with reclaim or an
  artist ATA `CreateIdempotent`: either can revert and roll back settlement.
  Confirm settlement, then submit reclaim separately with persisted retries.
- Escrow now has a 231-byte layout with appended `refund_due`. Settlement
  subtracts actual payments from that claim; reclaim refunds the smaller of the
  vault balance and the claim under the existing ATA fee rules, then sweeps any
  surplus to treasury. When the claim is zero, donated dust cannot make buyer
  ATA contents block closure. The 223-byte layout is rejected; coordinate the
  program and regenerated client release rather than mixing their layouts.

Base is `main`, with #118 merged before this client (#119); the
database chain #117 and #120 is already merged. No generation or x402 route changes belong in
this stack. Do not call any escrow RPC in production until per-image claims
exist; the nonce rail is removed/drained in the coordinated cutover release.
The missing-buyer-ATA refund behavior is unchanged and belongs in the Terms.
