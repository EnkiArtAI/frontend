-- Run during the cutover maintenance window, after stopping old admissions.
-- A successful check does not replace on-chain receipt/nonce/ledger reconciliation.
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.generation_payment_intents i
    WHERE i.deposit_confirmed_at IS NULL AND (
      ((i.nonce_account IS NOT NULL OR i.authorized_at IS NOT NULL) AND i.voided_at IS NULL AND i.captured_at IS NULL)
      OR (i.captured_at IS NOT NULL AND (i.tx_signature IS NULL OR i.fulfilled_at IS NULL))
      OR (i.status='confirmed' AND i.total_micro>0 AND i.fulfilled_at IS NULL AND i.voided_at IS NULL)
    )
  ) THEN
    RAISE EXCEPTION 'Legacy payments need reconciliation before escrow cutover' USING ERRCODE='55000';
  END IF;
END $$;
COMMIT;
