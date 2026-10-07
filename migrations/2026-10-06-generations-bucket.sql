-- REC-2: the fallback store for generated images (lib/generation/derivative-store.ts
-- FALLBACK_BUCKET). When Vercel Blob cannot take an image, it lands here, so a
-- 2K or 4K render, too big to travel inline, is still delivered.
--
-- Probed live 2026-10-06: only the bucket "profiles" exists. Public read like
-- Blob (the gallery shows the URL); writes come from the server's service role
-- only, which needs no policy. 50 MB covers a 4K PNG (measured up to 21 MB).
-- Idempotent. Safe to run before the code deploys: nothing writes here until then.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('generations', 'generations', true, 52428800, ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Read back:
--   SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'generations';
