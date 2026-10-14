-- Release reservations left by a crash before deposit persistence.
-- A persisted deposit, even only prepared, still requires chain expiry proof.
BEGIN;
CREATE OR REPLACE FUNCTION public.expire_orphaned_generation_escrow_reservations(p_limit integer DEFAULT 20)
RETURNS TABLE(intent_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_id uuid; v_intent public.generation_payment_intents%ROWTYPE;
BEGIN
  FOR v_id IN
    SELECT i.id FROM public.generation_payment_intents i
    WHERE i.status IN ('quoted','building') AND i.expires_at<=now()
      AND i.deposit_signature IS NULL AND i.deposit_confirmed_at IS NULL
      AND i.nonce_account IS NULL AND i.nonce_authority IS NULL AND i.authorized_at IS NULL
      AND i.authorized_tx_ct IS NULL AND i.authorized_tx_iv IS NULL
      AND i.authorized_tx_tag IS NULL AND i.authorized_tx_kid IS NULL AND i.heartbeat_at IS NULL
      AND i.captured_at IS NULL AND i.voided_at IS NULL AND i.void_reason IS NULL
      AND i.consumed_at IS NULL AND i.fulfilled_at IS NULL AND i.tx_signature IS NULL
      AND EXISTS(SELECT 1 FROM public.generation_escrow_recovery r WHERE r.intent_id=i.id AND r.state='reserved')
      AND NOT EXISTS(SELECT 1 FROM public.generation_escrow_deposits d WHERE d.intent_id=i.id)
    ORDER BY i.expires_at,i.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit,20),1),50)
    FOR UPDATE OF i SKIP LOCKED
  LOOP
    -- Preparation takes this same intent lock before writing its deposit.
    -- Re-read after acquiring it, rather than trusting the selection snapshot.
    SELECT * INTO v_intent FROM public.generation_payment_intents WHERE id=v_id;
    IF v_intent.status NOT IN ('quoted','building') OR v_intent.expires_at>now()
      OR v_intent.deposit_signature IS NOT NULL OR v_intent.deposit_confirmed_at IS NOT NULL
      OR v_intent.nonce_account IS NOT NULL OR v_intent.nonce_authority IS NOT NULL OR v_intent.authorized_at IS NOT NULL
      OR v_intent.authorized_tx_ct IS NOT NULL OR v_intent.authorized_tx_iv IS NOT NULL
      OR v_intent.authorized_tx_tag IS NOT NULL OR v_intent.authorized_tx_kid IS NOT NULL OR v_intent.heartbeat_at IS NOT NULL
      OR v_intent.captured_at IS NOT NULL OR v_intent.voided_at IS NOT NULL OR v_intent.void_reason IS NOT NULL
      OR v_intent.consumed_at IS NOT NULL OR v_intent.fulfilled_at IS NOT NULL OR v_intent.tx_signature IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.generation_escrow_deposits d WHERE d.intent_id=v_id)
      OR NOT EXISTS(SELECT 1 FROM public.generation_escrow_recovery r WHERE r.intent_id=v_id AND r.state='reserved') THEN
      CONTINUE;
    END IF;
    UPDATE public.generation_payment_intents SET status='expired',updated_at=now() WHERE id=v_id;
    -- The existing RPC preserves its audit row and takes the artist/mint lock.
    PERFORM public.cancel_unfunded_generation_escrow_recovery(v_id);
    RETURN QUERY SELECT v_id;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.expire_orphaned_generation_escrow_reservations(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.expire_orphaned_generation_escrow_reservations(integer) TO service_role;
COMMIT;
