-- ClickUp 123qmzqzw1w: persist the exact deposit before signing/broadcast.
-- Live columns, constraints and indexes re-probed read-only on 2026-10-06.
-- Requires 2026-10-05-escrow-recovery-reservations.sql. No route is activated.
-- Every RPC locks the owned intent first, then its deposit, matching recovery.
BEGIN;

CREATE TABLE IF NOT EXISTS public.generation_escrow_deposits (
  intent_id uuid PRIMARY KEY REFERENCES public.generation_escrow_recovery(intent_id),
  program_address text NOT NULL CHECK (program_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  cluster text NOT NULL CHECK (cluster IN ('solana-devnet', 'solana')),
  buyer_address text NOT NULL CHECK (buyer_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  rent_payer text NOT NULL CHECK (rent_payer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  treasury_owner text NOT NULL CHECK (treasury_owner ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND treasury_owner <> '11111111111111111111111111111111'),
  escrow_address text NOT NULL CHECK (escrow_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  vault_address text NOT NULL CHECK (vault_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  unsigned_transaction bytea NOT NULL CHECK (octet_length(unsigned_transaction) BETWEEN 130 AND 1232),
  message bytea NOT NULL CHECK (octet_length(message) BETWEEN 3 AND 1103),
  blockhash text NOT NULL CHECK (blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  last_valid_block_height bigint NOT NULL CHECK (last_valid_block_height > 0),
  chain_now_seconds bigint NOT NULL CHECK (chain_now_seconds >= 0),
  expires_at_seconds bigint NOT NULL,
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','submitting','submitted','funded','expired')),
  submission_token uuid,
  signed_transaction bytea,
  signature text CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  confirmed_slot bigint CHECK (confirmed_slot > 0),
  expired_block_height bigint,
  absence_checked_slot bigint CHECK (absence_checked_slot > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  expired_at timestamptz,
  CHECK (buyer_address <> rent_payer),
  CHECK (expires_at_seconds - chain_now_seconds BETWEEN 600 AND 1800),
  -- Exactly two empty signature slots followed by the original legacy message.
  -- Only the signature count is pinned: the buyer is a read-only signer in the
  -- program (Deposit.buyer has no mut), so the header's second byte is 01.
  CHECK (substring(unsigned_transaction FROM 1 FOR 1) = decode('02','hex')
    AND substring(message FROM 1 FOR 1) = decode('02','hex')
    AND substring(unsigned_transaction FROM 2 FOR 128) = decode(repeat('00',128),'hex')
    AND substring(unsigned_transaction FROM 130) = message),
  CHECK ((signed_transaction IS NULL AND signature IS NULL AND submitted_at IS NULL)
    OR (signed_transaction IS NOT NULL AND signature IS NOT NULL AND submitted_at IS NOT NULL
      AND octet_length(signed_transaction) = octet_length(unsigned_transaction)
      AND substring(signed_transaction FROM 1 FOR 1) = decode('02','hex')
      AND substring(signed_transaction FROM 130) = message
      AND substring(signed_transaction FROM 2 FOR 64) <> decode(repeat('00',64),'hex')
      AND substring(signed_transaction FROM 66 FOR 64) <> decode(repeat('00',64),'hex'))),
  CHECK (
    (state = 'prepared' AND submission_token IS NULL AND signed_transaction IS NULL)
    OR (state = 'submitting' AND submission_token IS NOT NULL AND signed_transaction IS NULL)
    OR (state IN ('submitted','funded') AND submission_token IS NOT NULL AND signed_transaction IS NOT NULL)
    OR state = 'expired'
  ),
  CHECK ((state = 'funded' AND confirmed_slot IS NOT NULL AND confirmed_at IS NOT NULL)
    OR (state <> 'funded' AND confirmed_slot IS NULL AND confirmed_at IS NULL)),
  CHECK ((state = 'expired' AND expired_block_height IS NOT NULL
      AND expired_block_height > last_valid_block_height
      AND absence_checked_slot IS NOT NULL AND expired_at IS NOT NULL)
    OR (state <> 'expired' AND expired_block_height IS NULL
      AND absence_checked_slot IS NULL AND expired_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS generation_escrow_deposits_address_idx
  ON public.generation_escrow_deposits(cluster,program_address,escrow_address);
CREATE UNIQUE INDEX IF NOT EXISTS generation_escrow_deposits_signature_idx
  ON public.generation_escrow_deposits(cluster,signature) WHERE signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS generation_escrow_deposits_pending_idx
  ON public.generation_escrow_deposits(last_valid_block_height)
  WHERE state IN ('prepared','submitting','submitted');
ALTER TABLE public.generation_escrow_deposits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_escrow_deposits FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.generation_escrow_deposits TO service_role;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'generation_escrow_deposits' AND policyname = 'Escrow deposit service read') THEN
    CREATE POLICY "Escrow deposit service read" ON public.generation_escrow_deposits
      FOR SELECT TO service_role USING (true);
  END IF;
END $$;

-- Inputs come from the server-built quote/Kit transaction, never the request.
-- The application validates the configured program, canonical PDAs, case-exact
-- buyer wallet and encoded amounts against the immutable recovery snapshot.
-- A racing preparation returns the FIRST stored message, never replaces it.
CREATE OR REPLACE FUNCTION public.prepare_generation_escrow_deposit(
  p_intent_id uuid, p_owner_wallet text, p_program_address text, p_cluster text,
  p_buyer_address text, p_rent_payer text, p_treasury_owner text,
  p_escrow_address text, p_vault_address text, p_unsigned_transaction bytea,
  p_message bytea, p_blockhash text, p_last_valid_block_height bigint,
  p_chain_now_seconds bigint, p_expires_at_seconds bigint
) RETURNS public.generation_escrow_deposits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_intent public.generation_payment_intents%ROWTYPE;
  v_recovery public.generation_escrow_recovery%ROWTYPE;
  v_result public.generation_escrow_deposits%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM public.generation_payment_intents
    WHERE id = p_intent_id AND buyer_wallet = p_owner_wallet FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment intent not found' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_result FROM public.generation_escrow_deposits WHERE intent_id = p_intent_id;
  IF FOUND THEN RETURN v_result; END IF;
  SELECT * INTO v_recovery FROM public.generation_escrow_recovery WHERE intent_id = p_intent_id;
  IF NOT FOUND OR v_recovery.state <> 'reserved'
      OR v_recovery.total_unit_micro <> v_intent.total_micro
      OR v_recovery.original_artist_unit_micro <> v_intent.artist_amount_micro
      OR v_recovery.artist_wallet IS DISTINCT FROM v_intent.artist_wallet
      OR (p_cluster = 'solana-devnet' AND v_recovery.mint <> '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
      OR (p_cluster = 'solana' AND v_recovery.mint <> 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
      OR v_intent.status NOT IN ('quoted','building') OR v_intent.expires_at <= now()
      OR v_intent.nonce_account IS NOT NULL OR v_intent.authorized_at IS NOT NULL
      OR v_intent.captured_at IS NOT NULL OR v_intent.voided_at IS NOT NULL
      OR v_intent.consumed_at IS NOT NULL OR v_intent.fulfilled_at IS NOT NULL
      OR v_intent.deposit_signature IS NOT NULL OR v_intent.deposit_confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Payment intent cannot prepare escrow' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.generation_escrow_deposits
    (intent_id,program_address,cluster,buyer_address,rent_payer,treasury_owner,
     escrow_address,vault_address,unsigned_transaction,message,blockhash,
     last_valid_block_height,chain_now_seconds,expires_at_seconds)
  VALUES (p_intent_id,p_program_address,p_cluster,p_buyer_address,p_rent_payer,p_treasury_owner,
          p_escrow_address,p_vault_address,p_unsigned_transaction,p_message,p_blockhash,
          p_last_valid_block_height,p_chain_now_seconds,p_expires_at_seconds) RETURNING * INTO v_result;
  UPDATE public.generation_payment_intents SET status = 'building', updated_at = now()
    WHERE id = p_intent_id;
  RETURN v_result;
END $$;

-- Call after checking the current chain height and buyer signature. Only the
-- winner may add Enki's signature. A crash before persisting the signed wire
-- remains submitting until proved unfunded after blockhash expiry; no takeover.
CREATE OR REPLACE FUNCTION public.begin_generation_escrow_submit(
  p_intent_id uuid, p_owner_wallet text, p_submission_token uuid, p_current_block_height bigint
) RETURNS SETOF public.generation_escrow_deposits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.generation_payment_intents
    WHERE id = p_intent_id AND buyer_wallet = p_owner_wallet AND status = 'building'
      AND nonce_account IS NULL AND authorized_at IS NULL AND captured_at IS NULL
      AND voided_at IS NULL AND consumed_at IS NULL AND fulfilled_at IS NULL
      AND deposit_signature IS NULL AND deposit_confirmed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR p_submission_token IS NULL OR p_current_block_height IS NULL
      OR p_current_block_height < 0 THEN RETURN; END IF;
  RETURN QUERY UPDATE public.generation_escrow_deposits
    SET state = 'submitting', submission_token = p_submission_token
    WHERE intent_id = p_intent_id AND state = 'prepared'
      AND last_valid_block_height >= p_current_block_height
    RETURNING *;
END $$;

-- Kit verifies BOTH signatures and exact original message before this call.
-- Never simulate/broadcast until the returned row contains these exact bytes.
CREATE OR REPLACE FUNCTION public.store_generation_escrow_signed_deposit(
  p_intent_id uuid, p_owner_wallet text, p_submission_token uuid,
  p_signed_transaction bytea, p_signature text
) RETURNS public.generation_escrow_deposits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_result public.generation_escrow_deposits%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.generation_payment_intents
    WHERE id = p_intent_id AND buyer_wallet = p_owner_wallet FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment intent not found' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_result FROM public.generation_escrow_deposits WHERE intent_id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR p_submission_token IS NULL OR p_signed_transaction IS NULL OR p_signature IS NULL
      OR v_result.submission_token IS DISTINCT FROM p_submission_token THEN
    RAISE EXCEPTION 'Deposit submission was not acquired' USING ERRCODE = '22023';
  END IF;
  IF v_result.state IN ('submitted','funded') THEN
    IF v_result.signed_transaction IS DISTINCT FROM p_signed_transaction
        OR v_result.signature IS DISTINCT FROM p_signature THEN
      RAISE EXCEPTION 'Stored deposit transaction differs' USING ERRCODE = '22023';
    END IF;
    RETURN v_result;
  END IF;
  IF v_result.state <> 'submitting' THEN
    RAISE EXCEPTION 'Deposit submission is closed' USING ERRCODE = '22023';
  END IF;
  UPDATE public.generation_escrow_deposits
    SET state = 'submitted', signed_transaction = p_signed_transaction,
        signature = p_signature, submitted_at = now()
    WHERE intent_id = p_intent_id RETURNING * INTO v_result;
  UPDATE public.generation_payment_intents SET status = 'submitted', updated_at = now()
    WHERE id = p_intent_id;
  RETURN v_result;
END $$;

-- Only after successful confirmed/finalized transaction status AND the SDK's
-- verifyFundedEscrow proof of escrow+vault at minContextSlot >= this slot.
-- This RPC does not verify Solana. A buyer-supplied signature is never proof.
CREATE OR REPLACE FUNCTION public.confirm_generation_escrow_deposit(
  p_intent_id uuid, p_owner_wallet text, p_signature text, p_confirmed_slot bigint
) RETURNS public.generation_escrow_deposits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_intent public.generation_payment_intents%ROWTYPE;
  v_result public.generation_escrow_deposits%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM public.generation_payment_intents
    WHERE id = p_intent_id AND buyer_wallet = p_owner_wallet FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment intent not found' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_result FROM public.generation_escrow_deposits WHERE intent_id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR p_signature IS NULL OR p_confirmed_slot IS NULL OR p_confirmed_slot <= 0
      OR v_result.signature IS DISTINCT FROM p_signature THEN
    RAISE EXCEPTION 'Stored deposit confirmation differs' USING ERRCODE = '22023';
  END IF;
  IF v_result.state = 'funded' THEN RETURN v_result; END IF;
  IF v_result.state <> 'submitted' OR v_intent.status <> 'submitted'
      OR v_intent.deposit_signature IS NOT NULL OR v_intent.deposit_confirmed_at IS NOT NULL
      OR v_intent.nonce_account IS NOT NULL OR v_intent.authorized_at IS NOT NULL
      OR v_intent.consumed_at IS NOT NULL OR v_intent.voided_at IS NOT NULL
      OR v_intent.captured_at IS NOT NULL THEN
    RAISE EXCEPTION 'Deposit cannot be confirmed' USING ERRCODE = '22023';
  END IF;
  UPDATE public.generation_escrow_deposits
    SET state = 'funded', confirmed_slot = p_confirmed_slot, confirmed_at = now()
    WHERE intent_id = p_intent_id RETURNING * INTO v_result;
  UPDATE public.generation_payment_intents
    SET status = 'confirmed', deposit_signature = p_signature,
        deposit_confirmed_at = v_result.confirmed_at, updated_at = now()
    WHERE id = p_intent_id;
  RETURN v_result;
END $$;

-- The sweeper must FIRST rule out a landed signature and prove both canonical
-- PDAs absent at a finalized bank after lastValidBlockHeight. Persist that bank's
-- height/slot. RPC failures or a merely elapsed wall-clock deadline are NOT proof.
CREATE OR REPLACE FUNCTION public.expire_unfunded_generation_escrow_deposit(
  p_intent_id uuid, p_owner_wallet text, p_finalized_block_height bigint, p_absence_checked_slot bigint
) RETURNS public.generation_escrow_deposits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_intent public.generation_payment_intents%ROWTYPE;
  v_result public.generation_escrow_deposits%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM public.generation_payment_intents
    WHERE id = p_intent_id AND buyer_wallet = p_owner_wallet FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment intent not found' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_result FROM public.generation_escrow_deposits WHERE intent_id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR p_finalized_block_height IS NULL OR p_absence_checked_slot IS NULL
      OR p_absence_checked_slot <= 0 OR p_finalized_block_height <= v_result.last_valid_block_height THEN
    RAISE EXCEPTION 'Deposit blockhash has not expired' USING ERRCODE = '22023';
  END IF;
  IF v_result.state = 'expired' THEN RETURN v_result; END IF;
  IF v_result.state = 'funded' OR v_intent.deposit_signature IS NOT NULL
      OR v_intent.deposit_confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Funded deposit cannot expire as absent' USING ERRCODE = '22023';
  END IF;
  UPDATE public.generation_escrow_deposits
    SET state = 'expired', expired_block_height = p_finalized_block_height,
        absence_checked_slot = p_absence_checked_slot, expired_at = now()
    WHERE intent_id = p_intent_id RETURNING * INTO v_result;
  UPDATE public.generation_payment_intents SET status = 'expired', updated_at = now()
    WHERE id = p_intent_id;
  PERFORM public.cancel_unfunded_generation_escrow_recovery(p_intent_id);
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.prepare_generation_escrow_deposit(uuid,text,text,text,text,text,text,text,text,bytea,bytea,text,bigint,bigint,bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_generation_escrow_submit(uuid,text,uuid,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_generation_escrow_signed_deposit(uuid,text,uuid,bytea,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_generation_escrow_deposit(uuid,text,text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_unfunded_generation_escrow_deposit(uuid,text,bigint,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_generation_escrow_deposit(uuid,text,text,text,text,text,text,text,text,bytea,bytea,text,bigint,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_generation_escrow_submit(uuid,text,uuid,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_generation_escrow_signed_deposit(uuid,text,uuid,bytea,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_generation_escrow_deposit(uuid,text,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_unfunded_generation_escrow_deposit(uuid,text,bigint,bigint) TO service_role;

COMMIT;
