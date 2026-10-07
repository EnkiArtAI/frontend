-- Wallet unlock (Kev, 2026-10-07, decision 3): CDP asks our server for a
-- JWT before every wallet request, so POST /api/auth/wallet/jwt is the one
-- place a stolen session can be stopped from signing or exporting directly
-- through CDP. It mints only for a session that passed a "wallet" or
-- "export" step-up at most 2 h ago (stepup_at) and used the wallet in the
-- last 15 min (stepup_seen_at, refreshed by every mint). A row never stamped
-- is locked.
--
-- Run in the SQL editor BEFORE the code deploys (until then the JWT route
-- answers 503), then read it back through PostgREST:
--   GET /rest/v1/auth_sessions?select=stepup_at,stepup_seen_at&limit=0  -> 200
-- Probed live 2026-10-07: stepup_at absent (42703).

ALTER TABLE public.auth_sessions
  ADD COLUMN IF NOT EXISTS stepup_at timestamptz,
  ADD COLUMN IF NOT EXISTS stepup_seen_at timestamptz;
