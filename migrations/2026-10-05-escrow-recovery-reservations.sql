-- ClickUp 123qmzqzw1w: reserve artist-account recovery across open escrows.
-- Based on the live schema probe of 2026-10-05 (columns, constraints, indexes,
-- RLS policies). Additive and idempotent. Deploy separately from application code.
-- Activate these RPCs only after the old nonce rail has stopped accepting
-- payments and its pending recoveries have drained: its direct ledger writes
-- do not participate in the escrow reservation lock.
-- Per-image generation claims must be implemented before any production call.
BEGIN;

ALTER TABLE public.generation_payment_intents
  ADD COLUMN IF NOT EXISTS deposit_signature text,
  ADD COLUMN IF NOT EXISTS deposit_confirmed_at timestamptz;

CREATE TABLE IF NOT EXISTS public.generation_escrow_recovery (
  intent_id uuid PRIMARY KEY REFERENCES public.generation_payment_intents(id),
  artist_wallet text,
  mint text NOT NULL CHECK (mint IN (
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  )),
  units smallint NOT NULL CHECK (units BETWEEN 1 AND 24),
  total_unit_micro bigint NOT NULL CHECK (total_unit_micro > 0),
  original_artist_unit_micro bigint NOT NULL CHECK (original_artist_unit_micro >= 0),
  fronted_original_micro bigint NOT NULL CHECK (fronted_original_micro >= 0),
  recovery_unit_micro bigint NOT NULL CHECK (recovery_unit_micro >= 0),
  treasury_unit_micro bigint GENERATED ALWAYS AS
    (total_unit_micro - original_artist_unit_micro + recovery_unit_micro) STORED,
  artist_unit_micro bigint GENERATED ALWAYS AS
    (original_artist_unit_micro - recovery_unit_micro) STORED,
  reserved_micro bigint GENERATED ALWAYS AS (units::bigint * recovery_unit_micro) STORED,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'confirmed', 'released')),
  delivered_units smallint,
  settlement_signature text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  released_at timestamptz,
  CHECK (original_artist_unit_micro <= total_unit_micro),
  CHECK (original_artist_unit_micro = 0 OR (artist_wallet IS NOT NULL AND artist_wallet <> '')),
  CHECK (recovery_unit_micro <= original_artist_unit_micro / 2),
  CHECK (
    (state = 'reserved' AND delivered_units IS NULL AND settlement_signature IS NULL
      AND confirmed_at IS NULL AND released_at IS NULL)
    OR (state = 'confirmed' AND delivered_units IS NOT NULL AND delivered_units BETWEEN 0 AND units
      AND settlement_signature IS NOT NULL AND settlement_signature <> ''
      AND confirmed_at IS NOT NULL AND released_at IS NULL)
    OR (state = 'released' AND delivered_units IS NULL AND settlement_signature IS NULL
      AND confirmed_at IS NULL AND released_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS generation_escrow_recovery_open_account_idx
  ON public.generation_escrow_recovery (artist_wallet, mint) WHERE state = 'reserved';
ALTER TABLE public.generation_escrow_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_escrow_recovery FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.generation_escrow_recovery TO service_role;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'generation_escrow_recovery' AND policyname = 'Escrow recovery service read') THEN
    CREATE POLICY "Escrow recovery service read" ON public.generation_escrow_recovery
      FOR SELECT TO service_role USING (true);
  END IF;
END $$;

-- The quote amounts remain per image. This RPC snapshots the two net legs,
-- preserving their sum; it never changes prices or appends a ledger recovery.
-- The server must read and verify the program's current Config account before
-- calling: p_max_deposit_micro is Config.max_deposit_micro, with no SQL default
-- or independent limit. It must never come from a buyer request.
CREATE OR REPLACE FUNCTION public.reserve_generation_escrow_recovery(
  p_intent_id uuid, p_units integer, p_mint text, p_max_deposit_micro bigint
) RETURNS public.generation_escrow_recovery
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_intent public.generation_payment_intents%ROWTYPE;
  v_result public.generation_escrow_recovery%ROWTYPE;
  v_fronted bigint := 0;
  v_outstanding bigint := 0;
  v_reserved bigint := 0;
  v_recovery bigint := 0;
BEGIN
  IF p_max_deposit_micro IS NULL OR p_max_deposit_micro <= 0
      OR p_units IS NULL OR p_units NOT BETWEEN 1 AND 24 OR p_mint IS NULL
      OR p_mint NOT IN ('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
                        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') THEN
    RAISE EXCEPTION 'Invalid escrow reservation arguments' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_intent FROM public.generation_payment_intents
    WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment intent not found' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_result FROM public.generation_escrow_recovery WHERE intent_id = p_intent_id;
  IF FOUND THEN
    IF v_result.state <> 'reserved' THEN
      RAISE EXCEPTION 'Escrow reservation is final' USING ERRCODE = '22023';
    END IF;
    IF v_result.units <> p_units OR v_result.mint <> p_mint
        OR v_result.artist_wallet IS DISTINCT FROM v_intent.artist_wallet
        OR v_result.total_unit_micro <> v_intent.total_micro
        OR v_result.original_artist_unit_micro <> v_intent.artist_amount_micro THEN
      RAISE EXCEPTION 'Escrow reservation snapshot differs' USING ERRCODE = '22023';
    END IF;
    RETURN v_result;
  END IF;
  IF v_intent.status NOT IN ('quoted', 'building') OR v_intent.expires_at <= now()
      OR v_intent.deposit_confirmed_at IS NOT NULL OR v_intent.nonce_account IS NOT NULL
      OR v_intent.total_micro <= 0
      OR v_intent.artist_amount_micro > v_intent.total_micro
      OR (v_intent.artist_amount_micro > 0 AND
          (v_intent.artist_wallet IS NULL OR v_intent.artist_wallet = '')) THEN
    RAISE EXCEPTION 'Payment intent cannot reserve escrow recovery' USING ERRCODE = '22023';
  END IF;
  IF v_intent.total_micro::numeric * p_units > p_max_deposit_micro THEN
    RAISE EXCEPTION 'Escrow deposit exceeds its cap' USING ERRCODE = '22023';
  END IF;
  IF v_intent.artist_amount_micro > 0 THEN
    -- Every escrow reservation, confirmation and cancellation takes the intent
    -- row first, then this account lock. No lock is held across an RPC request.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'enki-escrow-recovery:' || v_intent.artist_wallet || ':' || p_mint, 0));
    SELECT COALESCE(sum(micro) FILTER (WHERE entry = 'fronted'), 0),
           COALESCE(sum(CASE WHEN entry = 'fronted' THEN micro ELSE -micro END), 0)
      INTO v_fronted, v_outstanding FROM public.artist_cost_ledger
      WHERE artist_wallet = v_intent.artist_wallet AND mint = p_mint;
    SELECT COALESCE(sum(reserved_micro), 0) INTO v_reserved
      FROM public.generation_escrow_recovery
      WHERE artist_wallet = v_intent.artist_wallet AND mint = p_mint AND state = 'reserved';
    -- Section 7 (2026-10-06): half the artist share per delivered unit until
    -- rent is recovered. No instalment limit; floor both integer bounds.
    v_recovery := LEAST(v_intent.artist_amount_micro / 2,
                       GREATEST(v_outstanding - v_reserved, 0) / p_units);
  END IF;
  INSERT INTO public.generation_escrow_recovery
    (intent_id, artist_wallet, mint, units, total_unit_micro,
     original_artist_unit_micro, fronted_original_micro, recovery_unit_micro)
  VALUES (p_intent_id, v_intent.artist_wallet, p_mint, p_units, v_intent.total_micro,
          v_intent.artist_amount_micro, v_fronted, v_recovery) RETURNING * INTO v_result;
  RETURN v_result;
END $$;

-- Call only after confirming the settlement transaction and verifying its
-- stored PDA fields and k. A signature string alone is not chain verification.
-- The backend, not this database, performs that verification.
CREATE OR REPLACE FUNCTION public.confirm_generation_escrow_recovery(
  p_intent_id uuid, p_delivered_units integer, p_settlement_signature text
) RETURNS public.generation_escrow_recovery
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_intent public.generation_payment_intents%ROWTYPE;
  v_result public.generation_escrow_recovery%ROWTYPE;
  v_recovered bigint;
  v_outstanding bigint;
BEGIN
  SELECT * INTO v_intent FROM public.generation_payment_intents
    WHERE id = p_intent_id FOR UPDATE;
  SELECT * INTO v_result FROM public.generation_escrow_recovery WHERE intent_id = p_intent_id;
  IF NOT FOUND OR p_delivered_units IS NULL OR p_delivered_units NOT BETWEEN 0 AND v_result.units
      OR p_settlement_signature IS NULL OR btrim(p_settlement_signature) = '' THEN
    RAISE EXCEPTION 'Invalid escrow recovery confirmation' USING ERRCODE = '22023';
  END IF;
  IF v_result.state = 'confirmed' THEN
    IF v_result.delivered_units <> p_delivered_units
        OR v_result.settlement_signature <> p_settlement_signature THEN
      RAISE EXCEPTION 'Escrow recovery confirmation differs' USING ERRCODE = '22023';
    END IF;
    RETURN v_result;
  END IF;
  IF v_result.state <> 'reserved' OR v_intent.deposit_confirmed_at IS NULL
      OR v_intent.deposit_signature IS NULL OR btrim(v_intent.deposit_signature) = '' THEN
    RAISE EXCEPTION 'Escrow deposit has not been confirmed' USING ERRCODE = '22023';
  END IF;
  IF v_result.artist_wallet IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'enki-escrow-recovery:' || v_result.artist_wallet || ':' || v_result.mint, 0));
  END IF;
  v_recovered := p_delivered_units::bigint * v_result.recovery_unit_micro;
  IF v_recovered > 0 THEN
    SELECT COALESCE(sum(CASE WHEN entry = 'fronted' THEN micro ELSE -micro END), 0)
      INTO v_outstanding FROM public.artist_cost_ledger
      WHERE artist_wallet = v_result.artist_wallet AND mint = v_result.mint;
    IF v_recovered > v_outstanding THEN
      RAISE EXCEPTION 'Escrow recovery exceeds outstanding debt' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.artist_cost_ledger (artist_wallet, mint, entry, micro, intent_id)
      VALUES (v_result.artist_wallet, v_result.mint, 'recovered', v_recovered, p_intent_id);
  END IF;
  UPDATE public.generation_escrow_recovery
    SET state = 'confirmed', delivered_units = p_delivered_units,
        settlement_signature = p_settlement_signature, confirmed_at = now()
    WHERE intent_id = p_intent_id RETURNING * INTO v_result;
  -- This same transaction removes the entire N*r reservation. Only k*r was
  -- recovered, so (N-k)*r is now available to another intent.
  RETURN v_result;
END $$;

-- Call only after block-height expiry and a confirmed, sufficiently recent
-- chain read proves that no deposit PDA exists. Discovering a landed deposit
-- instead requires settle(0) / reclaim and a confirmed settlement above.
CREATE OR REPLACE FUNCTION public.cancel_unfunded_generation_escrow_recovery(p_intent_id uuid)
RETURNS public.generation_escrow_recovery
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_intent public.generation_payment_intents%ROWTYPE;
  v_result public.generation_escrow_recovery%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM public.generation_payment_intents
    WHERE id = p_intent_id FOR UPDATE;
  SELECT * INTO v_result FROM public.generation_escrow_recovery WHERE intent_id = p_intent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Escrow reservation not found' USING ERRCODE = '22023'; END IF;
  IF v_result.state = 'released' THEN RETURN v_result; END IF;
  IF v_result.state <> 'reserved' OR v_intent.status NOT IN ('expired', 'failed')
      OR v_intent.deposit_confirmed_at IS NOT NULL OR v_intent.deposit_signature IS NOT NULL THEN
    RAISE EXCEPTION 'Funded or active escrow recovery cannot be cancelled' USING ERRCODE = '22023';
  END IF;
  IF v_result.artist_wallet IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'enki-escrow-recovery:' || v_result.artist_wallet || ':' || v_result.mint, 0));
  END IF;
  UPDATE public.generation_escrow_recovery SET state = 'released', released_at = now()
    WHERE intent_id = p_intent_id RETURNING * INTO v_result;
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.reserve_generation_escrow_recovery(uuid, integer, text, bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_generation_escrow_recovery(uuid, integer, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_unfunded_generation_escrow_recovery(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_generation_escrow_recovery(uuid, integer, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_generation_escrow_recovery(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_unfunded_generation_escrow_recovery(uuid) TO service_role;

COMMIT;
