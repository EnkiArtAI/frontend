-- Persist each server-only settle/reclaim attempt before broadcasting it.
-- A retry gets the first pending wire. Rebuilding requires a finalized expiry proof.
BEGIN;
CREATE TABLE IF NOT EXISTS public.generation_escrow_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES public.generation_escrow_batches(intent_id),
  kind text NOT NULL CHECK (kind IN ('settle','reclaim')),
  state text NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted','confirmed','expired')),
  signed_transaction bytea NOT NULL CHECK (octet_length(signed_transaction) BETWEEN 100 AND 1232),
  signature text NOT NULL UNIQUE CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  blockhash text NOT NULL CHECK (blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height >= 0),
  confirmed_slot bigint CHECK (confirmed_slot > 0), expired_block_height bigint, absence_checked_slot bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (get_byte(signed_transaction,0) BETWEEN 1 AND 2),
  CHECK (octet_length(signed_transaction)>1+get_byte(signed_transaction,0)*64+70),
  CHECK (get_byte(signed_transaction,1+get_byte(signed_transaction,0)*64)=get_byte(signed_transaction,0)),
  CHECK (substring(signed_transaction FROM 2 FOR 64)<>decode(repeat('00',64),'hex')),
  CHECK (get_byte(signed_transaction,0)=1 OR substring(signed_transaction FROM 66 FOR 64)<>decode(repeat('00',64),'hex')),
  CHECK ((state='confirmed')=(confirmed_slot IS NOT NULL)),
  CHECK (state<>'expired' OR (expired_block_height>last_valid_block_height AND absence_checked_slot>0))
);
CREATE UNIQUE INDEX IF NOT EXISTS generation_escrow_transactions_inflight_idx
  ON public.generation_escrow_transactions(intent_id) WHERE state='submitted';
CREATE UNIQUE INDEX IF NOT EXISTS generation_escrow_transactions_pending_idx
  ON public.generation_escrow_transactions(intent_id,kind) WHERE state='submitted';
CREATE UNIQUE INDEX IF NOT EXISTS generation_escrow_transactions_confirmed_idx
  ON public.generation_escrow_transactions(intent_id,kind) WHERE state='confirmed';
ALTER TABLE public.generation_escrow_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_escrow_transactions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.generation_escrow_transactions TO service_role;

CREATE OR REPLACE FUNCTION public.store_generation_escrow_transaction(
  p_intent_id uuid,p_owner_wallet text,p_kind text,p_signed_transaction bytea,p_signature text,
  p_blockhash text,p_last_valid_block_height bigint,p_chain_now_seconds bigint)
RETURNS public.generation_escrow_transactions LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_batch public.generation_escrow_batches%ROWTYPE; v_result public.generation_escrow_transactions%ROWTYPE; v_expiry bigint;
BEGIN
  PERFORM 1 FROM public.generation_payment_intents WHERE id=p_intent_id AND buyer_wallet=p_owner_wallet FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_batch FROM public.generation_escrow_batches WHERE intent_id=p_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch is not ready' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_result FROM public.generation_escrow_transactions WHERE intent_id=p_intent_id AND kind=p_kind AND state IN ('submitted','confirmed');
  IF FOUND THEN RETURN v_result; END IF;
  IF EXISTS(SELECT 1 FROM public.generation_escrow_transactions WHERE intent_id=p_intent_id AND state='submitted') THEN
    RAISE EXCEPTION 'Another escrow transaction needs reconciliation' USING ERRCODE='22023';
  END IF;
  SELECT expires_at_seconds INTO v_expiry FROM public.generation_escrow_deposits WHERE intent_id=p_intent_id;
  IF p_kind IS NULL OR p_kind NOT IN ('settle','reclaim') OR p_chain_now_seconds IS NULL OR p_chain_now_seconds<0
    OR (p_kind='settle' AND (v_batch.state<>'ready' OR v_expiry<=GREATEST(p_chain_now_seconds,extract(epoch FROM now())::bigint)))
    OR (p_kind='reclaim' AND NOT (v_batch.state IN ('settled','refunded') OR
      (v_batch.state='ready' AND v_expiry<=LEAST(p_chain_now_seconds,extract(epoch FROM now())::bigint)))) THEN
    RAISE EXCEPTION 'Batch cannot send this transaction' USING ERRCODE='22023'; END IF;
  INSERT INTO public.generation_escrow_transactions(intent_id,kind,signed_transaction,signature,blockhash,last_valid_block_height)
    VALUES(p_intent_id,p_kind,p_signed_transaction,p_signature,p_blockhash,p_last_valid_block_height) RETURNING * INTO v_result;
  RETURN v_result;
END $$;

-- Call only after a successful receipt plus matching settled account, or a successful
-- reclaim receipt plus absence of both canonical PDAs at or beyond that receipt's slot.
CREATE OR REPLACE FUNCTION public.confirm_generation_escrow_transaction(
  p_intent_id uuid,p_owner_wallet text,p_transaction_id uuid,p_signature text,p_confirmed_slot bigint)
RETURNS public.generation_escrow_batches LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_batch public.generation_escrow_batches%ROWTYPE; v_tx public.generation_escrow_transactions%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.generation_payment_intents WHERE id=p_intent_id AND buyer_wallet=p_owner_wallet FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_batch FROM public.generation_escrow_batches WHERE intent_id=p_intent_id FOR UPDATE;
  SELECT * INTO v_tx FROM public.generation_escrow_transactions WHERE id=p_transaction_id AND intent_id=p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_tx.signature IS DISTINCT FROM p_signature OR p_confirmed_slot IS NULL OR p_confirmed_slot<=0
    OR v_tx.state='expired' THEN RAISE EXCEPTION 'Transaction proof differs' USING ERRCODE='22023'; END IF;
  IF v_tx.state='confirmed' THEN RETURN v_batch; END IF;
  IF v_tx.kind='settle' THEN
    IF v_batch.state<>'ready' THEN RAISE EXCEPTION 'Batch cannot settle' USING ERRCODE='22023'; END IF;
    PERFORM public.confirm_generation_escrow_recovery(p_intent_id,v_batch.delivered_units,p_signature);
    UPDATE public.generation_escrow_batches SET state='settled',settlement_signature=p_signature,updated_at=now()
      WHERE intent_id=p_intent_id RETURNING * INTO v_batch;
  ELSE
    IF v_batch.state='ready' THEN
      -- Escrow expired before settlement. All unspent funds were reclaimed; book no recovery.
      PERFORM public.confirm_generation_escrow_recovery(p_intent_id,0,p_signature);
    ELSIF v_batch.state NOT IN ('settled','refunded') THEN
      RAISE EXCEPTION 'Batch cannot close' USING ERRCODE='22023'; END IF;
    UPDATE public.generation_escrow_batches SET state='closed',updated_at=now()
      WHERE intent_id=p_intent_id RETURNING * INTO v_batch;
  END IF;
  UPDATE public.generation_escrow_transactions SET state='confirmed',confirmed_slot=p_confirmed_slot WHERE id=p_transaction_id;
  UPDATE public.generation_payment_intents SET
    fulfilled_at=CASE WHEN v_batch.delivered_units>0 THEN COALESCE(fulfilled_at,now()) ELSE fulfilled_at END,
    tx_signature=COALESCE(v_batch.settlement_signature,p_signature),updated_at=now()
    WHERE id=p_intent_id;
  RETURN v_batch;
END $$;

-- The service must also rule out a landed receipt and verify the expected canonical
-- escrow state at this finalized bank. A timeout never expires a signed attempt.
CREATE OR REPLACE FUNCTION public.expire_generation_escrow_transaction(
  p_intent_id uuid,p_owner_wallet text,p_transaction_id uuid,p_finalized_block_height bigint,p_absence_checked_slot bigint)
RETURNS public.generation_escrow_transactions LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_tx public.generation_escrow_transactions%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.generation_payment_intents WHERE id=p_intent_id AND buyer_wallet=p_owner_wallet FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_tx FROM public.generation_escrow_transactions WHERE id=p_transaction_id AND intent_id=p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_tx.state='confirmed' OR p_finalized_block_height IS NULL OR p_finalized_block_height<=v_tx.last_valid_block_height
    OR p_absence_checked_slot IS NULL OR p_absence_checked_slot<=0 THEN
    RAISE EXCEPTION 'Finalized expiry required' USING ERRCODE='22023'; END IF;
  UPDATE public.generation_escrow_transactions SET state='expired',expired_block_height=p_finalized_block_height,
    absence_checked_slot=p_absence_checked_slot WHERE id=p_transaction_id RETURNING * INTO v_tx;
  RETURN v_tx;
END $$;

REVOKE ALL ON FUNCTION public.store_generation_escrow_transaction(uuid,text,text,bytea,text,text,bigint,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.confirm_generation_escrow_transaction(uuid,text,uuid,text,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.expire_generation_escrow_transaction(uuid,text,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.store_generation_escrow_transaction(uuid,text,text,bytea,text,text,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_generation_escrow_transaction(uuid,text,uuid,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_generation_escrow_transaction(uuid,text,uuid,bigint,bigint) TO service_role;
-- Atomic scan rotation prevents permanently blocked old orders from starving new work.
ALTER TABLE public.generation_escrow_deposits ADD COLUMN IF NOT EXISTS reconciliation_checked_at timestamptz;
CREATE OR REPLACE FUNCTION public.generation_escrow_work_items(p_limit integer DEFAULT 20)
RETURNS TABLE(intent_id uuid,owner_wallet text,deposit_state text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH candidates AS (
    SELECT d.intent_id,i.buyer_wallet
    FROM public.generation_escrow_deposits d
    JOIN public.generation_payment_intents i ON i.id=d.intent_id
    LEFT JOIN public.generation_escrow_batches b ON b.intent_id=d.intent_id
    WHERE d.state IN ('prepared','submitting','submitted','funded') AND (b.state IS NULL OR b.state<>'closed')
    ORDER BY d.reconciliation_checked_at NULLS FIRST,COALESCE(b.updated_at,d.created_at),d.intent_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit,20),1),50)
    FOR UPDATE OF d SKIP LOCKED
  ), marked AS (
    UPDATE public.generation_escrow_deposits d SET reconciliation_checked_at=clock_timestamp()
    FROM candidates c WHERE d.intent_id=c.intent_id
    RETURNING d.intent_id,c.buyer_wallet,d.state
  )
  SELECT m.intent_id,m.buyer_wallet,m.state FROM marked m
$$;
REVOKE ALL ON FUNCTION public.generation_escrow_work_items(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.generation_escrow_work_items(integer) TO service_role;
COMMIT;
