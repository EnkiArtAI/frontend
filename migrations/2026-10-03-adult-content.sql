-- 18+ content (Kev, 2026-10-03): 18+ or below, no age classes yet.
--
--   users.adult_confirmed_at    the user's own word in Settings that they are
--                               18 or older, with its time; NULL = not confirmed
--   prompts.is_adult            set by the prompt check when a prompt is saved
--   generated_images.is_adult   set when an image is recorded, from the prompt
--                               check or the prompt's own mark
--
-- Every read of other people's work filters on is_adult = false unless the
-- viewer confirmed and turned the feed's 18+ pill on. NOT NULL DEFAULT false
-- marks every existing row as not 18+ in the same statement, so those reads
-- keep returning everything they returned before.
--
-- Verified live 2026-10-03 (PostgREST): none of the three columns exists.
-- Run BEFORE deploying the code: it filters on these columns, and a filter on
-- a missing column fails the whole read (PostgREST 400), feed included.
--
-- Re-runnable.

ALTER TABLE users            ADD COLUMN IF NOT EXISTS adult_confirmed_at timestamptz;
ALTER TABLE prompts          ADD COLUMN IF NOT EXISTS is_adult boolean NOT NULL DEFAULT false;
ALTER TABLE generated_images ADD COLUMN IF NOT EXISTS is_adult boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
