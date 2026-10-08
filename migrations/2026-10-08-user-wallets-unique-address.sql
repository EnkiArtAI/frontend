-- One live row per wallet address, whatever its case (2026-10-08).
-- Every wallet lookup reads user_wallets case-insensitively with
-- .ilike().maybeSingle(); two live rows for one address make it fail, and the
-- owner then has "no wallet": paid generation answers 409, the gallery reads
-- empty, step-up fails, and (until this batch) each login minted a new empty
-- user. That happened to a founder's wallet on 2026-08-26 and was cleaned up
-- by hand on 2026-10-07. This index stops it from coming back.
--
-- Solana addresses are case-sensitive base58, so two different Solana
-- addresses could in theory differ only in case; the app already treats them
-- as one (every lookup is case-insensitive), so the index changes nothing it
-- did not already assume.
--
-- Checked live 2026-10-08: 15 live rows, 0 case-insensitive duplicates.
-- Small table, so no CONCURRENTLY (it cannot run inside the SQL editor's
-- transaction anyway). Read back afterwards:
--   select indexname from pg_indexes where indexname = 'user_wallets_live_address_ci';

create unique index if not exists user_wallets_live_address_ci
  on public.user_wallets (lower(address))
  where removed_at is null;
