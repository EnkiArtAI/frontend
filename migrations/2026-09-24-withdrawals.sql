-- "Send USDC" (withdraw) requests: one row per server-built transfer the user
-- signs and we broadcast (app/api/wallet/withdraw/build + submit).
--
-- The row is the security record, not a ledger: message_hash pins the exact
-- transaction the fee payer co-signed, so /submit can refuse anything the
-- client altered; created_at bounds the 60 s signing window; the per-user
-- count over the last hour is the money-limit that lib/rate-limit.ts (per
-- Vercel instance, in memory) cannot provide. Every row counts, whatever
-- its status: the fee payer signed on /build, the rest is the client's.
--
-- Live state on 2026-09-23: this table did NOT exist (PostgREST PGRST205),
-- re-verified 2026-09-24. Run once in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS withdrawals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  from_address  text NOT NULL,
  to_address    text NOT NULL,
  amount_micro  bigint NOT NULL CHECK (amount_micro > 0),
  mint          text NOT NULL,
  message_hash  text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'expired')),
  tx_signature  text UNIQUE,
  ip_hash       text,
  error         text,
  created_at    timestamptz DEFAULT now(),
  submitted_at  timestamptz,
  confirmed_at  timestamptz
);

-- The hourly limit query: WHERE user_id = ? AND created_at > now() - 1h.
CREATE INDEX IF NOT EXISTS withdrawals_user_created_idx
  ON withdrawals (user_id, created_at);

-- RLS on, NO policies: only the service role (our routes) reads or writes,
-- the same posture as password_credentials.
ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;

-- Count and insert in ONE statement under the user's advisory lock, so N
-- parallel /build calls (one instance or many) get at most p_limit rows in
-- any hour; past it the RAISE reaches the route as SQLSTATE P0001
-- "WITHDRAW_LIMIT" and becomes the 429. Called by lib/payments/withdraw.ts
-- insertWithdrawal; the JS count before it is only a fast path.
CREATE OR REPLACE FUNCTION withdrawal_begin(
  p_user uuid,
  p_from text,
  p_to text,
  p_amount_micro bigint,
  p_mint text,
  p_message_hash text,
  p_ip_hash text,
  p_limit int
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_user::text));
  IF (SELECT count(*) FROM withdrawals
      WHERE user_id = p_user AND created_at > now() - interval '1 hour') >= p_limit THEN
    RAISE EXCEPTION 'WITHDRAW_LIMIT' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO withdrawals (user_id, from_address, to_address, amount_micro, mint, message_hash, ip_hash)
  VALUES (p_user, p_from, p_to, p_amount_micro, p_mint, p_message_hash, p_ip_hash)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION withdrawal_begin(uuid, text, text, bigint, text, text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION withdrawal_begin(uuid, text, text, bigint, text, text, text, int) TO service_role;
