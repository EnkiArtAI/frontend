-- Zero cost search (Kev, 2026-09-24: "das muss dann kostenlos sein"):
-- Postgres full text + trigram, nothing metered. Run in the SQL editor.
--
-- Probed live via PostgREST on 2026-09-24 before writing this:
--   prompts: id uuid, title text, description text, tags text[] (NOT jsonb),
--            is_listed boolean, listing_status text ('draft' | 'active' seen),
--            deleted_at timestamptz, opens bigint (nullable), views bigint,
--            encrypted_content / _iv / _tag / _kid text.
--            12 rows, 2 listed + active + undeleted. tags is [] on every row.
--   users:   id uuid, handle public.citext, display_name text, avatar_url text,
--            account_status text ('active' on all 28), deleted_at timestamptz,
--            is_creator boolean (1 true against 2 users with listed prompts,
--            so it is NOT maintained and NOT used below).
--   bans:    user_id uuid, expires_at timestamptz, lifted_at timestamptz
--            (0 rows). A ban never delists prompts, so every function below
--            excludes a banned creator itself.
--   prompts.search_tsv: absent (42703). search_prompts(): absent (PGRST202).
--   Extension availability is not visible through PostgREST; pg_trgm ships
--   with Supabase. unaccent is deliberately NOT used: unaccent() is STABLE,
--   so it can sit neither in a generated column nor in an index, and
--   applying it to the query alone would match nothing the index holds.
--
-- The encrypted body never enters the index: search_tsv is built from
-- title, description and tags only, and no function below reads an
-- encrypted_* or email_* column.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- array_to_string is STABLE, which a generated column refuses; this
-- wrapper is honest about the one call it makes.
CREATE OR REPLACE FUNCTION tags_to_text(tags text[])
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT array_to_string(tags, ' ') $$;

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
-- tags) or by title similarity. rank = text rank + title similarity, so a
-- near exact title and a tag hit both count.
CREATE OR REPLACE FUNCTION search_prompts(q text, lim int, off int)
RETURNS TABLE (id uuid, rank real)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT p.id,
         (ts_rank(p.search_tsv, websearch_to_tsquery('english', q))
          + similarity(lower(p.title), lower(q)))::real
  FROM prompts p
  WHERE p.is_listed = true
    AND p.deleted_at IS NULL
    AND p.listing_status = 'active'
    AND NOT EXISTS (SELECT 1 FROM bans b
                    WHERE b.user_id = p.creator_id
                      AND b.lifted_at IS NULL
                      AND (b.expires_at IS NULL OR b.expires_at > now()))
    AND (p.search_tsv @@ websearch_to_tsquery('english', q)
         OR similarity(lower(p.title), lower(q)) > 0.3)
  ORDER BY 2 DESC, coalesce(p.opens, 0) DESC, p.id
  LIMIT lim OFFSET off
$$;

-- Title suggestions: prefix first, then similar titles. The LIKE pattern
-- is escaped so a typed % or _ stays a character.
CREATE OR REPLACE FUNCTION suggest_titles(q text, lim int)
RETURNS TABLE (id uuid, title text)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT p.id, p.title
  FROM prompts p
  WHERE p.is_listed = true
    AND p.deleted_at IS NULL
    AND p.listing_status = 'active'
    AND NOT EXISTS (SELECT 1 FROM bans b
                    WHERE b.user_id = p.creator_id
                      AND b.lifted_at IS NULL
                      AND (b.expires_at IS NULL OR b.expires_at > now()))
    AND (lower(p.title) LIKE lower(replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_')) || '%'
         OR similarity(lower(p.title), lower(q)) > 0.3)
  ORDER BY (lower(p.title) LIKE lower(replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_')) || '%') DESC,
           similarity(lower(p.title), lower(q)) DESC,
           coalesce(p.opens, 0) DESC,
           p.id
  LIMIT lim
$$;

-- Active creators by handle or display name: only users with a listed
-- prompt, so a buyer who never published is not enumerable by prefix.
-- Returns only the public profile fields a result card shows.
CREATE OR REPLACE FUNCTION search_creators(q text, lim int)
RETURNS TABLE (id uuid, handle text, display_name text, avatar_url text)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT u.id, u.handle::text, u.display_name, u.avatar_url
  FROM users u
  WHERE u.account_status = 'active'
    AND u.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM prompts p
                WHERE p.creator_id = u.id
                  AND p.is_listed = true
                  AND p.deleted_at IS NULL
                  AND p.listing_status = 'active')
    AND NOT EXISTS (SELECT 1 FROM bans b
                    WHERE b.user_id = u.id
                      AND b.lifted_at IS NULL
                      AND (b.expires_at IS NULL OR b.expires_at > now()))
    AND (lower(u.handle::text) LIKE lower(replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_')) || '%'
         OR similarity(lower(u.handle::text), lower(q)) > 0.3
         OR similarity(lower(coalesce(u.display_name, '')), lower(q)) > 0.3)
  ORDER BY greatest(similarity(lower(u.handle::text), lower(q)),
                    similarity(lower(coalesce(u.display_name, '')), lower(q))) DESC,
           u.id
  LIMIT lim
$$;
