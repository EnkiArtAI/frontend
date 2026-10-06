-- Generators split by MEDIUM (Kev, 2026-08-24: the filter tree shows
-- "Image" and "Video" branches, models under each). The models table gains
-- the media type; every existing row is an image model, so the default
-- backfills them and future video rows (Seedance, Kling, …) simply insert
-- with media_type = 'video' and appear in the tree by themselves.
ALTER TABLE models
  ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'image'
  CHECK (media_type IN ('image', 'video'));
