-- Invited accounts (Kev, 2026-10-07): an admin's approval creates the account
-- with a one-time password and mails it to the address. That password only
-- opens the "set your own password" step (POST /api/auth/password/first-login);
-- from then on only the user's own password logs in, and the email counts as
-- confirmed (password_credentials.email_verified_at, live already, unused so
-- far). A password reset through the inbox confirms the email too. The
-- embedded wallet stays closed until both hold. The one-time password never
-- expires: it is long enough (about 100 bits) that guessing it is no option.
--
-- Run in the SQL editor BEFORE the code deploys: login, first-login and the
-- wallet JWT read this column and answer 503 until it exists. Read it back:
--   GET /rest/v1/password_credentials?select=must_change_password&limit=0  -> 200
-- Probed live 2026-10-07: password_credentials has user_id, email, pw_hash,
-- pw_salt, created_at, updated_at, email_verified_at; 0 rows.

ALTER TABLE public.password_credentials
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
