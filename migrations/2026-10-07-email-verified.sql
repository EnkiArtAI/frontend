-- Signup confirms the login email with a 6-digit code, and that address is
-- the account's first step-up factor (Kev, 2026-10-07: every embedded wallet
-- has a factor). The stamp tells the wallet vendor the truth: until now the
-- wallet JWT claimed emailVerified for every account.
--
-- Run in the SQL editor, then read it back through PostgREST:
--   GET /rest/v1/password_credentials?select=email_verified_at&limit=0  -> 200
-- Probed live 2026-10-07: password_credentials has 0 rows and no
-- email_verified_at (42703).

ALTER TABLE public.password_credentials ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
