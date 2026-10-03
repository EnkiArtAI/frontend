-- Generation failures — the admin People tab shows every generation that was
-- accepted and then broke, with its settings, next to the person's warnings
-- (Kev, 2026-10-03).
--
-- Written only by the server (lib/generation/record.ts recordGenerationFailure,
-- best effort, from after()); read only by /api/admin. The prompt is stored
-- encrypted with the lib/crypto envelope, like automod evidence; for an
-- artist's prompt only the buyer's values are stored, never the artist's text.
-- user_id is nullable: the free generator runs without a login, so those rows
-- carry the hashed IP only. surface is free text on purpose: a CHECK would make
-- a future surface's inserts fail, and this insert fails silently by design.
--
-- Verified live 2026-10-03 (PostgREST): the table does not exist; users.id,
-- models.id and generation_payment_intents.id are uuid.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS generation_failures (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        REFERENCES users(id) ON DELETE SET NULL,
  ip_hash               text,                              -- HMAC-SHA256(ip, AUTH_PEPPER)
  surface               text        NOT NULL,              -- 'generate-image' | 'generate-free' | 'x402-generate'

  -- The settings the generation ran with
  model_id              uuid        REFERENCES models(id) ON DELETE SET NULL,
  resolution            text,
  quality               text,
  boost                 boolean     NOT NULL DEFAULT false,
  aspect_ratio          text,
  reference_image_count integer     NOT NULL DEFAULT 0,

  -- What broke, and what was asked for (encrypted)
  error                 text        NOT NULL,
  prompt_ct             text,
  prompt_iv             text,
  prompt_tag            text,
  prompt_kid            text,
  image_url             text,

  -- The payment it belonged to, if any
  intent_id             uuid        REFERENCES generation_payment_intents(id) ON DELETE SET NULL,
  tx_signature          text,

  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Per-person history (the expanded row) and the week's list.
CREATE INDEX IF NOT EXISTS generation_failures_user_idx
  ON generation_failures (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS generation_failures_created_idx
  ON generation_failures (created_at DESC);

-- Server-only, like every moderation table.
ALTER TABLE generation_failures ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'generation_failures'
      AND policyname = 'Service role access only'
  ) THEN
    CREATE POLICY "Service role access only" ON public.generation_failures
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON public.generation_failures FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- The admin People list: one row per person with a reason to look at them,
-- open cases flagged. Grouping happens here, so one busy account cannot push
-- everyone else out of a row-capped read. Someone without an account is keyed
-- by their hashed address. Read only by /api/admin (lib/admin/people.ts); the
-- counts per person come from the enforcement code, not from this view.
-- Verified live 2026-10-03: automod_events (decision, user_id, ip_hash,
-- review_state, created_at) and bans (user_id, lifted_at, expires_at,
-- created_at) exist.
CREATE OR REPLACE VIEW moderation_people AS
SELECT user_id, ip_hash, max(at) AS last_at, bool_or(open) AS pending
FROM (
  SELECT user_id, CASE WHEN user_id IS NULL THEN ip_hash END AS ip_hash,
         created_at AS at, review_state = 'pending' AS open
  FROM automod_events
  WHERE decision = 'block' AND (user_id IS NOT NULL OR ip_hash IS NOT NULL)
  UNION ALL
  SELECT user_id, CASE WHEN user_id IS NULL THEN ip_hash END, created_at, false
  FROM generation_failures
  WHERE created_at > now() - interval '7 days' AND (user_id IS NOT NULL OR ip_hash IS NOT NULL)
  UNION ALL
  SELECT user_id, NULL, created_at, false
  FROM bans
  WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
) AS reasons
GROUP BY user_id, ip_hash;

-- A view runs with its owner's rights, so the public roles must not reach it.
REVOKE ALL ON public.moderation_people FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
