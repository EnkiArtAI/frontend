-- Sign in with Google and X (Kev, 2026-09-23/24). Identity model: a user has an
-- email OR a wallet OR a Google account OR an X account. Every provider account
-- maps to exactly one users row, and a user holds at most one identity per
-- provider. A provider identity whose email the provider marks as verified is
-- linked to the existing password account with that email; X users without an
-- email are allowed. Run once in the Supabase SQL editor.
--
-- Probed live 2026-09-24 via PostgREST with the service role:
--   users(id uuid, handle citext, display_name, avatar_url, email_ct, email_iv,
--         email_tag, email_kid, email_lookup_hash, email_verified_at,
--         account_status, role, ...)                          28 rows
--   access_allowlist(id, kind, value, note, created_at)        3 rows,
--         kinds in use: email, wallet. The CHECK constraint name was
--         confirmed by a rejected insert of kind '__invalid__':
--         access_allowlist_kind_check. Verify it in the SQL editor before
--         running if the table was changed since:
--           SELECT conname FROM pg_constraint
--           WHERE conrelid = 'access_allowlist'::regclass AND contype = 'c';
--   auth_identities                                            ABSENT

CREATE TABLE IF NOT EXISTS auth_identities (
  provider       text NOT NULL CHECK (provider IN ('google', 'x')),
  subject        text NOT NULL,                       -- provider's stable user id (Google sub, X id)
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email          text,                                -- as the provider reported it, lowercased
  email_verified boolean NOT NULL DEFAULT false,      -- only what the provider asserted
  handle         text,                                -- X username; null for Google
  display_name   text,
  avatar_url     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, user_id)
);

CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON auth_identities (user_id);

-- RLS on, no policies: only server routes (service role, bypasses RLS) touch it.
ALTER TABLE auth_identities ENABLE ROW LEVEL SECURITY;

-- Whitelist stage: X users have a handle, not necessarily an email, so the
-- allowlist gets a third kind. value = the X username without the @, lowercased.
ALTER TABLE access_allowlist DROP CONSTRAINT IF EXISTS access_allowlist_kind_check;
ALTER TABLE access_allowlist
  ADD CONSTRAINT access_allowlist_kind_check CHECK (kind IN ('email', 'wallet', 'x'));
