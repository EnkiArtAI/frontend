-- One provider invocation per paid unit. Applies after the recovery and deposit migrations.
-- Exposed columns and PK/FK types were read from PostgREST on 2026-10-12.
-- No live data or pricing is changed. Existing nonce authorizations must be drained before cutover.
BEGIN;
CREATE TABLE IF NOT EXISTS public.generation_escrow_batches (
  intent_id uuid PRIMARY KEY REFERENCES public.generation_escrow_deposits(intent_id),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closing','ready','settled','refunded','closed')),
  delivered_units smallint CHECK (delivered_units BETWEEN 0 AND 24),
  settlement_signature text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state IN ('ready','settled','refunded','closed')) = (delivered_units IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.generation_escrow_units (
  intent_id uuid NOT NULL REFERENCES public.generation_escrow_batches(intent_id),
  unit_index smallint NOT NULL CHECK (unit_index BETWEEN 0 AND 23),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','delivered','failed')),
  claim_token uuid UNIQUE, user_id uuid REFERENCES public.users(id),
  lease_expires_at timestamptz, admitted_slot bigint CHECK (admitted_slot > 0),
  generation_id uuid UNIQUE REFERENCES public.generations(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (intent_id,unit_index),
  CHECK (state NOT IN ('running','delivered') OR (claim_token IS NOT NULL AND user_id IS NOT NULL AND lease_expires_at IS NOT NULL AND admitted_slot IS NOT NULL)),
  CHECK ((state = 'delivered') = (generation_id IS NOT NULL))
);
ALTER TABLE public.generation_escrow_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generation_escrow_units ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_escrow_batches,public.generation_escrow_units FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.generation_escrow_batches,public.generation_escrow_units TO service_role;
CREATE INDEX IF NOT EXISTS generation_escrow_units_running_idx ON public.generation_escrow_units(lease_expires_at) WHERE state='running';

-- Every transition takes the owned intent lock first, then its deposit and batch.
CREATE OR REPLACE FUNCTION public.ensure_generation_escrow_batch(p_intent_id uuid,p_owner_wallet text)
RETURNS public.generation_escrow_batches LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_deposit public.generation_escrow_deposits%ROWTYPE; v_units integer;
        v_batch public.generation_escrow_batches%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.generation_payment_intents WHERE id=p_intent_id AND buyer_wallet=p_owner_wallet
    AND status='confirmed' AND deposit_signature IS NOT NULL AND deposit_confirmed_at IS NOT NULL
    AND nonce_account IS NULL AND authorized_at IS NULL AND captured_at IS NULL AND voided_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Funded payment not found' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_deposit FROM public.generation_escrow_deposits WHERE intent_id=p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_deposit.state<>'funded' THEN RAISE EXCEPTION 'Deposit is not funded' USING ERRCODE='22023'; END IF;
  SELECT units INTO v_units FROM public.generation_escrow_recovery WHERE intent_id=p_intent_id AND state IN ('reserved','confirmed');
  IF NOT FOUND THEN RAISE EXCEPTION 'Recovery snapshot missing' USING ERRCODE='22023'; END IF;
  INSERT INTO public.generation_escrow_batches(intent_id) VALUES(p_intent_id) ON CONFLICT DO NOTHING;
  INSERT INTO public.generation_escrow_units(intent_id,unit_index)
    SELECT p_intent_id,generate_series(0,v_units-1) ON CONFLICT DO NOTHING;
  SELECT * INTO v_batch FROM public.generation_escrow_batches WHERE intent_id=p_intent_id FOR UPDATE;
  RETURN v_batch;
END $$;

-- Service calls only after re-verifying the funded canonical escrow+vault at this bank.
-- The lease covers the 300-second route, with a separate 60-second settlement margin.
-- Retrying an acquired unit NEVER grants permission for another provider invocation.
CREATE OR REPLACE FUNCTION public.claim_generation_escrow_unit(
  p_intent_id uuid,p_owner_wallet text,p_user_id uuid,p_unit_index integer,p_claim_token uuid,
  p_chain_now_seconds bigint,p_admitted_slot bigint)
RETURNS SETOF public.generation_escrow_units LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_batch public.generation_escrow_batches%ROWTYPE; v_deposit public.generation_escrow_deposits%ROWTYPE;
BEGIN
  v_batch:=public.ensure_generation_escrow_batch(p_intent_id,p_owner_wallet);
  SELECT * INTO v_deposit FROM public.generation_escrow_deposits WHERE intent_id=p_intent_id;
  IF v_batch.state<>'open' OR p_claim_token IS NULL OR p_user_id IS NULL OR p_unit_index IS NULL
    OR p_chain_now_seconds IS NULL OR p_admitted_slot IS NULL OR p_admitted_slot<v_deposit.confirmed_slot
    OR p_chain_now_seconds<v_deposit.chain_now_seconds
    OR v_deposit.expires_at_seconds<=GREATEST(p_chain_now_seconds,extract(epoch FROM now())::bigint)+420
    OR NOT (p_owner_wallet=p_user_id::text OR EXISTS(
      SELECT 1 FROM public.user_wallets WHERE user_id=p_user_id AND address=p_owner_wallet AND removed_at IS NULL)) THEN
    RETURN;
  END IF;
  RETURN QUERY UPDATE public.generation_escrow_units SET state='running',claim_token=p_claim_token,user_id=p_user_id,
    lease_expires_at=now()+interval '360 seconds',admitted_slot=p_admitted_slot,updated_at=now()
    WHERE intent_id=p_intent_id AND unit_index=p_unit_index AND state='pending' RETURNING *;
END $$;

-- Only a durable, accepted image row belonging to the claimed user counts as delivered.
CREATE OR REPLACE FUNCTION public.deliver_generation_escrow_unit(
  p_intent_id uuid,p_owner_wallet text,p_unit_index integer,p_claim_token uuid,p_generation_id uuid)
RETURNS public.generation_escrow_units LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_batch public.generation_escrow_batches%ROWTYPE; v_unit public.generation_escrow_units%ROWTYPE;
BEGIN
  v_batch:=public.ensure_generation_escrow_batch(p_intent_id,p_owner_wallet);
  SELECT * INTO v_unit FROM public.generation_escrow_units WHERE intent_id=p_intent_id AND unit_index=p_unit_index FOR UPDATE;
  IF NOT FOUND OR v_unit.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'Unit claim not found' USING ERRCODE='22023'; END IF;
  IF v_unit.state='delivered' AND v_unit.generation_id=p_generation_id THEN RETURN v_unit; END IF;
  IF v_batch.state NOT IN ('open','closing') OR v_unit.state<>'running' OR v_unit.lease_expires_at<=now()
    OR NOT EXISTS(SELECT 1 FROM public.generations g JOIN public.generated_images i ON i.generation_id=g.id
      WHERE g.id=p_generation_id AND g.user_id=v_unit.user_id AND i.user_id=v_unit.user_id
        AND i.accepted IS TRUE AND i.is_uploaded IS FALSE AND i.storage_url IS NOT NULL AND i.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Unit has no durable delivered image' USING ERRCODE='22023'; END IF;
  UPDATE public.generation_escrow_units SET state='delivered',generation_id=p_generation_id,updated_at=now()
    WHERE intent_id=p_intent_id AND unit_index=p_unit_index RETURNING * INTO v_unit;
  RETURN v_unit;
END $$;

-- SETOF returns zero rows for a repeated/late failure rather than an all-null composite row.
DROP FUNCTION IF EXISTS public.fail_generation_escrow_unit(uuid,text,integer,uuid);
CREATE OR REPLACE FUNCTION public.fail_generation_escrow_unit(
  p_intent_id uuid,p_owner_wallet text,p_unit_index integer,p_claim_token uuid)
RETURNS SETOF public.generation_escrow_units LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.ensure_generation_escrow_batch(p_intent_id,p_owner_wallet);
  RETURN QUERY UPDATE public.generation_escrow_units SET state='failed',updated_at=now()
    WHERE intent_id=p_intent_id AND unit_index=p_unit_index AND claim_token=p_claim_token AND state='running'
    RETURNING *;
END $$;

-- No caller-supplied k. Freeze the count only after all running leases have ended.
-- Cancellation closes admission immediately, while existing requests can finish their leases.
CREATE OR REPLACE FUNCTION public.close_generation_escrow_batch(
  p_intent_id uuid,p_owner_wallet text,p_chain_now_seconds bigint,p_cancel boolean DEFAULT false)
RETURNS public.generation_escrow_batches LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_batch public.generation_escrow_batches%ROWTYPE; v_expiry bigint; v_count integer;
BEGIN
  v_batch:=public.ensure_generation_escrow_batch(p_intent_id,p_owner_wallet);
  IF v_batch.state IN ('ready','settled','refunded','closed') THEN RETURN v_batch; END IF;
  IF p_chain_now_seconds IS NULL OR p_chain_now_seconds<0 THEN
    RAISE EXCEPTION 'Chain time required' USING ERRCODE='22023'; END IF;
  SELECT expires_at_seconds INTO v_expiry FROM public.generation_escrow_deposits WHERE intent_id=p_intent_id;
  UPDATE public.generation_escrow_units SET state='failed',updated_at=now()
    WHERE intent_id=p_intent_id AND state='running' AND lease_expires_at<=now();
  IF p_cancel OR v_batch.state='closing' OR v_expiry<=GREATEST(p_chain_now_seconds,extract(epoch FROM now())::bigint)+420 THEN
    UPDATE public.generation_escrow_units SET state='failed',updated_at=now() WHERE intent_id=p_intent_id AND state='pending';
    UPDATE public.generation_escrow_batches SET state='closing',updated_at=now() WHERE intent_id=p_intent_id;
  END IF;
  IF EXISTS(SELECT 1 FROM public.generation_escrow_units WHERE intent_id=p_intent_id AND state IN ('pending','running')) THEN
    SELECT * INTO v_batch FROM public.generation_escrow_batches WHERE intent_id=p_intent_id;
    RETURN v_batch;
  END IF;
  SELECT count(*) INTO v_count FROM public.generation_escrow_units WHERE intent_id=p_intent_id AND state='delivered';
  UPDATE public.generation_escrow_batches SET state='ready',delivered_units=v_count,updated_at=now()
    WHERE intent_id=p_intent_id RETURNING * INTO v_batch;
  RETURN v_batch;
END $$;

REVOKE ALL ON FUNCTION public.ensure_generation_escrow_batch(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_generation_escrow_unit(uuid,text,uuid,integer,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.deliver_generation_escrow_unit(uuid,text,integer,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fail_generation_escrow_unit(uuid,text,integer,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.close_generation_escrow_batch(uuid,text,bigint,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_generation_escrow_batch(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_generation_escrow_unit(uuid,text,uuid,integer,uuid,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.deliver_generation_escrow_unit(uuid,text,integer,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_generation_escrow_unit(uuid,text,integer,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.close_generation_escrow_batch(uuid,text,bigint,boolean) TO service_role;
COMMIT;
