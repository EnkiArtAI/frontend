-- Step-up factors beside the passkey (MFA, Kev 2026-10-07: "not only passkey
-- but also more authentications if the user wants it, like authenticator or
-- email 6 digit verification code"). Run in the SQL editor, then read the
-- table back through PostgREST.
--
-- Probed live 2026-10-07: mfa_factors absent; auth_sessions = id, token,
-- wallet_address, wallet_type, expires_at, created_at, ip_hash;
-- users has no mfa_* column; webauthn_credentials 0 rows.
--
-- One row per user and kind. The TOTP secret and the email address are
-- encrypted with lib/crypto (AAD = user_id), the pending email code is an
-- HMAC under an AUTH_PEPPER-derived key: a dump of this table opens nothing.
-- failed_attempts is claimed with a conditional update before a code is
-- compared, so parallel guesses cannot buy extra tries.

CREATE TABLE IF NOT EXISTS public.mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('totp', 'email')),
  secret_ct text NOT NULL,
  secret_iv text NOT NULL,
  secret_tag text NOT NULL,
  secret_kid text NOT NULL,
  confirmed_at timestamptz,
  last_step bigint,
  code_hash text,
  code_expires_at timestamptz,
  code_sent_at timestamptz,
  sends_day date,
  sends_count smallint NOT NULL DEFAULT 0,
  failed_attempts smallint NOT NULL DEFAULT 0,
  lockouts smallint NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind)
);

-- No policies: only the server's service role reads or writes it.
ALTER TABLE public.mfa_factors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mfa_factors FROM anon, authenticated;
