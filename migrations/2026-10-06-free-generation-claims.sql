-- ENG-20: a free generation is claimed atomically BEFORE the render.
--
-- The allowance (3 per account) was counted from generations rows, written in
-- after() once the response had gone: parallel requests all read "2 used" and
-- all rendered, and a failed insert was never counted at all. A claim is taken
-- under a per-account lock before the provider is called, refunded only when
-- the render fails, and is the count the allowance reads.
--
-- Probed live 2026-10-06: no table of this name; users.id uuid; generations
-- holds 9 rows, all provider 'pollinations' (the free one), from one account.
-- Additive and idempotent. Run BEFORE deploying the code that calls
-- claim_free_generation: without it every free generation is refused.
BEGIN;

CREATE TABLE IF NOT EXISTS public.free_generation_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS free_generation_claims_user_idx ON public.free_generation_claims (user_id);
-- Service role only, like password_credentials: RLS on, no policies.
ALTER TABLE public.free_generation_claims ENABLE ROW LEVEL SECURITY;

-- Every free generation already made is a claim spent. Once, on the first run.
-- By provider, not amount_paid_cents: no path writes that column, so paid
-- renders carry NULL there too and would read as free.
INSERT INTO public.free_generation_claims (user_id, created_at)
SELECT g.user_id, g.created_at
FROM public.generations g
WHERE g.provider = 'pollinations'
  AND NOT EXISTS (SELECT 1 FROM public.free_generation_claims);

-- Returns the new claim's id, or NULL when the account has used p_limit.
CREATE OR REPLACE FUNCTION public.claim_free_generation(p_user_id uuid, p_limit int)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  -- One claim at a time per account: a parallel request waits here and then
  -- counts the claim the first one committed.
  PERFORM pg_advisory_xact_lock(hashtextextended('free_generation_claims:' || p_user_id::text, 0));
  IF (SELECT count(*) FROM public.free_generation_claims WHERE user_id = p_user_id) >= p_limit THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.free_generation_claims (user_id) VALUES (p_user_id) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.claim_free_generation(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_free_generation(uuid, int) TO service_role;

COMMIT;

-- Read back after it runs:
--   SELECT count(*) FROM public.free_generation_claims;          -- 9 on 2026-10-06
--   SELECT public.claim_free_generation('<a users.id with no claims>', 0);  -- NULL, inserts nothing
