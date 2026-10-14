-- Kev, 2026-10-12: one free image per UTC day, on the free baseline model.
-- Requires 2026-10-06-free-generation-claims.sql. Read-only REST probe on
-- 2026-10-12 verified free_generation_claims(id, user_id, created_at), all NOT NULL.
-- Keep claims separate from generation/image history: deleting history does
-- not restore a delivered image. Only a failed render releases its claim.
BEGIN;

CREATE INDEX IF NOT EXISTS free_generation_claims_user_created_idx
  ON public.free_generation_claims (user_id, created_at);

-- Keep the existing RPC signature for rolling deployments. A stale caller
-- passing the previous allowance (3) still cannot exceed today's hard cap (1).
CREATE OR REPLACE FUNCTION public.claim_free_generation(p_user_id uuid, p_limit int)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_now timestamptz;
  v_day_start timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_limit IS NULL OR p_limit <= 0 THEN
    RETURN NULL;
  END IF;
  -- Lock by account across day boundaries. Read the admission clock AFTER
  -- waiting for the lock; a transaction started yesterday claims today's slot.
  PERFORM pg_advisory_xact_lock(hashtextextended('free_generation_claims:' || p_user_id::text, 0));
  v_now := clock_timestamp();
  v_day_start := date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF (SELECT count(*) FROM public.free_generation_claims
      WHERE user_id = p_user_id
        AND created_at >= v_day_start
        AND created_at < v_day_start + interval '24 hours') >= LEAST(p_limit, 1) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.free_generation_claims (user_id, created_at)
    VALUES (p_user_id, v_now) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- The display reads the SAME database UTC day as the claim. A browser or
-- application-server clock must not reset the allowance early.
CREATE OR REPLACE FUNCTION public.free_generation_quota(p_user_id uuid)
RETURNS TABLE (used int, "limit" int, remaining int, exhausted boolean, resets_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_day_start timestamptz;
  v_used int;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'An account is required' USING ERRCODE = '22023';
  END IF;
  v_day_start := date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  SELECT count(*)::int INTO v_used FROM public.free_generation_claims
    WHERE user_id = p_user_id
      AND created_at >= v_day_start
      AND created_at < v_day_start + interval '24 hours';
  RETURN QUERY SELECT v_used, 1, GREATEST(0, 1 - v_used), v_used >= 1,
    v_day_start + interval '24 hours';
END $$;

REVOKE ALL ON FUNCTION public.claim_free_generation(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.free_generation_quota(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_free_generation(uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.free_generation_quota(uuid) TO service_role;

COMMIT;
