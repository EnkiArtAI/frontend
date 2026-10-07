-- Access requests can be rejected (Kev, 2026-10-07): the admin's Access tab
-- approves or rejects a pending request. status takes exactly pending,
-- approved or rejected. The original table (2026-06-30-access-requests.sql)
-- documents these values without a CHECK; whatever check the live table may
-- carry on status is replaced by this one, so "rejected" can never be refused.
--
-- Run in the SQL editor before the code deploys (rejecting answers 503 until
-- then if a stricter check exists), then read back:
--   GET /rest/v1/access_requests?select=status&limit=0  -> 200
-- Probed live 2026-10-07: access_requests has id, email, about, socials,
-- status (default 'pending'), created_at, updated_at; 1 row, status pending.

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.access_requests'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.access_requests DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.access_requests
  ADD CONSTRAINT access_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected'));
