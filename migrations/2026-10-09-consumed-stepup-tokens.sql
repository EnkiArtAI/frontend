-- Single-use step-up tokens for money scopes (MFA-1, feeds BAN-8). A step-up
-- JWT (lib/webauthn.ts mintStepUpToken) now carries a jti; requireStepUp
-- claims it here with a plain unique-key insert before it treats an
-- "export" or "withdraw:<id>" token as valid, so the SAME human approval
-- (one TOTP code, one passkey tap) can authorize at most ONE money action,
-- never a replay within the token's 5 minute TTL.
--
-- DB-backed, not in-memory (lib/rate-limit.ts's pattern): Vercel runs many
-- instances, and an in-memory consumed-set on one instance is invisible to
-- another. A row here is a used-up permission slip, not a payment record
-- (that is the `withdrawals` table) — no ledger semantics, no amounts.
--
-- Run once in the Supabase SQL editor, then read the table back through
-- PostgREST and paste the column list into the MFA-1 ClickUp task
-- (CONTRIBUTING.md Sec 4). Probed live 2026-10-09: table does not exist yet.

CREATE TABLE IF NOT EXISTS public.consumed_stepup_tokens (
  jti         uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  scope       text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

-- Housekeeping only (a token is inert the moment its own 5 minute TTL
-- passes): lets a future cron prune old rows without a seq scan.
CREATE INDEX IF NOT EXISTS consumed_stepup_tokens_consumed_at_idx
  ON public.consumed_stepup_tokens (consumed_at);

-- No policies: only the server's service role reads or writes it, same
-- posture as mfa_factors and withdrawals.
ALTER TABLE public.consumed_stepup_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.consumed_stepup_tokens FROM anon, authenticated;
