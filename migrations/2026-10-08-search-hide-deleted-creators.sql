-- search_prompts and suggest_titles left out a banned creator's prompts but
-- not those of a deleted or inactive account, so their titles stayed in the
-- search suggestions (2026-10-08). The rule is the app's hiddenOwners: an
-- account with deleted_at set or an account_status other than 'active'.
-- search_creators already applies it. CREATE OR REPLACE keeps each
-- function's grants: still the service role only.

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
    AND NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.id = p.creator_id
                      AND (u.deleted_at IS NOT NULL OR u.account_status <> 'active'))
    AND (p.search_tsv @@ websearch_to_tsquery('english', q)
         OR lower(p.title) % lower(q))
  ORDER BY 2 DESC, p.opens DESC, p.id
  LIMIT lim OFFSET off
$$;

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
    AND NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.id = p.creator_id
                      AND (u.deleted_at IS NOT NULL OR u.account_status <> 'active'))
    AND (lower(p.title) LIKE lower(replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_')) || '%'
         OR lower(p.title) % lower(q))
  ORDER BY (lower(p.title) LIKE lower(replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_')) || '%') DESC,
           similarity(lower(p.title), lower(q)) DESC,
           p.opens DESC,
           p.id
  LIMIT lim
$$;

-- Read back after running (PostgREST, service key):
--   POST /rest/v1/rpc/suggest_titles {"q":"a","lim":1,"show_adult":false}   -> 200
--   the same RPC with the ANON key                                          -> permission denied
