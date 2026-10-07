-- CUR-2 (Kev, 2026-10-08): a prompt's reference images, the "before" shown
-- beside its showcase. The editor always sent them with a save and the route
-- dropped them, while the stored text still says "Reference image N".
-- Same shape as showcase_images: a jsonb array of URLs in our stores.
--
-- Run in the SQL editor BEFORE the code deploys: the marketplace card, the
-- search and the save read and write this column, and PostgREST refuses a
-- select or write that names a column it does not know. Then read back:
--   GET /rest/v1/prompts?select=showcase_before_images&limit=1  -> 200

ALTER TABLE public.prompts
  ADD COLUMN IF NOT EXISTS showcase_before_images jsonb NOT NULL DEFAULT '[]'::jsonb;
