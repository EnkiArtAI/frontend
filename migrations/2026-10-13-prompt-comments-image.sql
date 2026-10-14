-- Reviews carry a generated image (Kev, 2026-10-13: "reviews = comments but
-- with a generated image; comments = einfach comment von jeder person").
--
-- A review points at one of the reviewer's own generated_images rows of the
-- prompt; app/api/prompts/[id]/comments checks that ownership before it
-- writes. The id, not the URL: the read joins the row's current preview, and
-- an image the owner deletes leaves the review without a picture instead of
-- a dead link. Applied live 2026-10-13 (sql-to-run/17). Safe to run twice.
ALTER TABLE public.prompt_comments
  ADD COLUMN IF NOT EXISTS image_id uuid REFERENCES public.generated_images(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS prompt_comments_image_id_idx ON public.prompt_comments (image_id);
