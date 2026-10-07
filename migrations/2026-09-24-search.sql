-- Zero cost search (Kev, 2026-09-24: "das muss dann kostenlos sein"):
-- Postgres full text + trigram, nothing metered. Run in the SQL editor.
--
-- Probed live via PostgREST on 2026-09-24, re-probed 2026-10-07:
--   prompts: id uuid, title text, description text, tags text[] NOT NULL,
--            is_listed boolean, listing_status text ('draft' | 'active' seen),
--            deleted_at timestamptz, opens bigint NOT NULL default 0,
--            is_adult boolean NOT NULL default false, views bigint,
--            encrypted_content / _iv / _tag / _kid text.
--            12 rows, 2 listed + active + undeleted.
--   users:   id uuid, handle public.citext, display_name text, avatar_url text,
--            account_status text ('active' on every row), deleted_at timestamptz,
--            is_creator boolean (NOT maintained and NOT used below).
--   bans:    user_id uuid, expires_at timestamptz, lifted_at timestamptz
--            (0 rows). A ban never delists prompts, so every function below
--            excludes a banned creator itself.
--   prompts.search_tsv: absent (42703). search_prompts, suggest_titles,
--   search_creators, tags_to_text: absent (PGRST202). pg_trgm: installed in
--   public (show_trgm/show_limit answer, similarity threshold 0.3), so the
--   CREATE EXTENSION below does nothing. unaccent is deliberately NOT used:
--   unaccent() is STABLE, so it can sit neither in a generated column nor in
--   an index, and applying it to the query alone would match nothing the
--   index holds.
--
-- The encrypted body never enters the index: search_tsv is built from
-- title, description and tags only, and no function below reads an
-- encrypted_* or email_* column. prompts.tags is computed by the server
-- (lib/search/tags.ts): a paid body adds at most five subjects, never how
-- the prompt is made (Kev, 2026-10-07). The functions answer ids and public
-- profile fields only, never which tag matched, and only the server may call
-- them: anon and authenticated are revoked at the end.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Earlier drafts of these functions, wherever one was ever run: without
-- this they would stay beside the new ones, unfiltered and executable by
-- PUBLIC.
DROP FUNCTION IF EXISTS search_prompts(text, int, int);
DROP FUNCTION IF EXISTS search_prompts(text, int, int, boolean);
DROP FUNCTION IF EXISTS suggest_titles(text, int);
DROP FUNCTION IF EXISTS search_creators(text, int);

-- array_to_string is STABLE, which a generated column refuses; this
-- wrapper is honest about the one call it makes.
CREATE OR REPLACE FUNCTION tags_to_text(tags text[])
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT pg_catalog.array_to_string(tags, ' ') $$;

ALTER TABLE prompts
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english'::regconfig,
      coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(tags_to_text(tags), '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS prompts_search_tsv_idx ON prompts USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS prompts_title_trgm_idx ON prompts USING gin (lower(title) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_handle_trgm_idx ON users USING gin (lower(handle::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_display_name_trgm_idx ON users USING gin (lower(display_name) gin_trgm_ops);

-- Listed prompts matching the query by full text (title, description,
-- tags) or by title similarity (% = similarity above pg_trgm's threshold,
-- which the trigram index can answer). rank = text rank + title similarity,
-- so a near exact title and a tag hit both count. 18+ only when the server
-- says the viewer is a confirmed adult who asked for it. models narrows to
-- the feed's generator filter (every alias of each pick, as ai_model stores
-- names and slugs mixed); NULL means every generator.
CREATE OR REPLACE FUNCTION search_prompts(q text, lim int, off int, show_adult boolean DEFAULT false, models text[] DEFAULT NULL)
RETURNS TABLE (id uuid, rank real)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT p.id,
         (ts_rank(p.search_tsv, websearch_to_tsquery('english', q))
          + similarity(lower(p.title), lower(q)))::real
  FROM prompts p
  WHERE p.is_listed = true
    AND p.deleted_at IS NULL
    AND p.listing_status = 'active'
    AND (show_adult OR p.is_adult = false)
    AND (models IS NULL OR p.ai_model = ANY (models))
    AND NOT EXISTS (SELECT 1 FROM bans b
                    WHERE b.user_id = p.creator_id
                      AND b.lifted_at IS NULL
                      AND (b.expires_at IS NULL OR b.expires_at > now()))
    AND (p.search_tsv @@ websearch_to_tsquery('english', q)
         OR lower(p.title) % lower(q))
  ORDER BY 2 DESC, p.opens DESC, p.id
  LIMIT lim OFFSET off
$$;

-- Title suggestions: prefix first, then similar titles. The LIKE pattern
-- is escaped so a typed % or _ stays a character.
CREATE OR REPLACE FUNCTION suggest_titles(q text, lim int, show_adult boolean DEFAULT false)
RETURNS TABLE (id uuid, title text)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.title
  FROM prompts p
  WHERE p.is_listed = true
    AND p.deleted_at IS NULL
    AND p.listing_status = 'active'
    AND (show_adult OR p.is_adult = false)
    AND NOT EXISTS (SELECT 1 FROM bans b
                    WHERE b.user_id = p.creator_id
                      AND b.lifted_at IS NULL
                      AND (b.expires_at IS NULL OR b.expires_at > now()))
    AND (lower(p.title) LIKE lower(replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_')) || '%'
         OR lower(p.title) % lower(q))
  ORDER BY (lower(p.title) LIKE lower(replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_')) || '%') DESC,
           similarity(lower(p.title), lower(q)) DESC,
           p.opens DESC,
           p.id
  LIMIT lim
$$;

-- Active creators by handle or display name: only users with a listed
-- prompt the viewer may see, so a buyer who never published (or an 18+ only
-- shelf, for a viewer below it) is not enumerable by prefix. Returns only
-- the public profile fields a result card shows.
CREATE OR REPLACE FUNCTION search_creators(q text, lim int, show_adult boolean DEFAULT false)
RETURNS TABLE (id uuid, handle text, display_name text, avatar_url text)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.handle::text, u.display_name, u.avatar_url
  FROM users u
  WHERE u.account_status = 'active'
    AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM prompts p
                WHERE p.creator_id = u.id
                  AND p.is_listed = true
                  AND p.deleted_at IS NULL
                  AND p.listing_status = 'active'
                  AND (show_adult OR p.is_adult = false))
    AND NOT EXISTS (SELECT 1 FROM bans b
                    WHERE b.user_id = u.id
                      AND b.lifted_at IS NULL
                      AND (b.expires_at IS NULL OR b.expires_at > now()))
    AND (lower(u.handle::text) LIKE lower(replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_')) || '%'
         OR lower(u.handle::text) % lower(q)
         OR lower(u.display_name) % lower(q))
  ORDER BY greatest(similarity(lower(u.handle::text), lower(q)),
                    similarity(lower(coalesce(u.display_name, '')), lower(q))) DESC,
           u.id
  LIMIT lim
$$;

-- Server only: /api/search and /api/search/suggest call these with the
-- service role and rate-limit per IP. The anon key ships in every browser
-- bundle; through it, the functions would be an unlimited query engine.
REVOKE ALL ON FUNCTION search_prompts(text, int, int, boolean, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION suggest_titles(text, int, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION search_creators(text, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION search_prompts(text, int, int, boolean, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION suggest_titles(text, int, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION search_creators(text, int, boolean) TO service_role;

-- Read back after running (PostgREST, service key):
--   GET  /rest/v1/prompts?select=id,search_tsv&limit=1                         -> 200
--   POST /rest/v1/rpc/search_prompts {"q":"x","lim":1,"off":0,"show_adult":false} -> 200
--   the same RPC with the ANON key                                            -> permission denied
