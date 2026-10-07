-- Who read an artist's prompt text, when, and why.
--
-- Kev, 2026-10-03: nobody sees an artist's text, mods included; only the most
-- important admins, in hard cases. Moderation records keep an artist's words
-- withheld (lib/moderation/evidence.ts), and only the moderation owner
-- (moderation_policy.owner_user_id) can reveal them in the admin panel, one
-- record at a time. The reveal writes its row here BEFORE it shows anything:
-- no row, no text.
--
-- Append-only like automod_events: a log of who read what is worth nothing if
-- the reader can erase it. revealed_by and prompt_id carry no foreign key on
-- purpose: a key's ON DELETE action would have to update this table, which the
-- trigger refuses, and would block deleting the user or the prompt.
--
-- Re-runnable: IF NOT EXISTS / DROP ... IF EXISTS before each CREATE.

CREATE TABLE IF NOT EXISTS artist_text_reveals (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid        NOT NULL REFERENCES automod_events(id),
  -- The marketplace prompt whose current text was revealed, when the record
  -- named one instead of holding the text.
  prompt_id    uuid,
  revealed_by  uuid        NOT NULL,
  reason       text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artist_text_reveals_event_idx ON artist_text_reveals (event_id);

-- Only the server's service role reads or writes it; no policy grants anyone else.
ALTER TABLE artist_text_reveals ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION artist_text_reveals_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'artist_text_reveals is append-only: % is not permitted on the reveal log',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS artist_text_reveals_no_change ON artist_text_reveals;
CREATE TRIGGER artist_text_reveals_no_change
  BEFORE UPDATE OR DELETE ON artist_text_reveals
  FOR EACH ROW EXECUTE FUNCTION artist_text_reveals_append_only();

-- TRUNCATE bypasses row-level triggers entirely, so it needs its own.
DROP TRIGGER IF EXISTS artist_text_reveals_no_truncate ON artist_text_reveals;
CREATE TRIGGER artist_text_reveals_no_truncate
  BEFORE TRUNCATE ON artist_text_reveals
  FOR EACH STATEMENT EXECUTE FUNCTION artist_text_reveals_append_only();

COMMENT ON TABLE artist_text_reveals IS
  'Append-only log of every reveal of an artist''s withheld prompt text by the '
  'moderation owner: which record, which prompt, who, why, when.';
