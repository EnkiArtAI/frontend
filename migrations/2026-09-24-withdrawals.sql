-- "Send USDC" (withdraw) requests: one row per server-built transfer the user
-- signs and we broadcast (app/api/wallet/withdraw/build + submit).
--
-- The row is the security record, not a ledger: message_hash pins the exact
-- transaction the fee payer co-signed, so /submit can refuse anything the
-- client altered; created_at bounds the 90 s signing window; the per-user
-- count over the last hour is the money-limit that lib/rate-limit.ts (per
-- Vercel instance, in memory) cannot provide.
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
