-- Databases that already ran 2026-10-06-escrow-deposit-persistence.sql carry a
-- structure check that pinned the message header to 02 00 (no read-only
-- signer). The deposit's buyer is a read-only signer (Deposit.buyer has no
-- mut in the program), so every compiled message starts 02 01 and
-- prepare_generation_escrow_deposit failed with 23514 (found on devnet,
-- 2026-10-12). Fresh installs get the corrected table definition; this
-- re-creates the check for existing ones. Safe to run twice.
BEGIN;
ALTER TABLE public.generation_escrow_deposits
  DROP CONSTRAINT IF EXISTS generation_escrow_deposits_check2;
ALTER TABLE public.generation_escrow_deposits
  ADD CONSTRAINT generation_escrow_deposits_check2 CHECK (
    substring(unsigned_transaction FROM 1 FOR 1) = decode('02','hex')
    AND substring(message FROM 1 FOR 1) = decode('02','hex')
    AND substring(unsigned_transaction FROM 2 FOR 128) = decode(repeat('00',128),'hex')
    AND substring(unsigned_transaction FROM 130) = message
  );
COMMIT;
