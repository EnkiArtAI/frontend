-- Wallets an account links to show their NFTs in the picker (Kev, 2026-10-08).
-- Their own table, read by the NFT list alone: a linked wallet never signs in,
-- pays, gets paid or shows publicly, because nothing else ever reads it. One
-- wallet may be linked to several accounts; that reveals only public NFTs.
-- The service role alone reads and writes it: RLS on, no policies.

create table if not exists public.linked_wallets (
  user_id uuid not null references public.users(id) on delete cascade,
  address text not null,
  linked_at timestamptz not null default now(),
  primary key (user_id, address)
);

alter table public.linked_wallets enable row level security;
