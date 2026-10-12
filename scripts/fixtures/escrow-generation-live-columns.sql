-- Minimal referenced columns from the read-only PostgREST probe, 2026-10-12.
-- This fixture does not claim to reproduce unexposed production CHECK constraints.
CREATE TABLE IF NOT EXISTS public.users(id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public.user_wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES public.users(id),address text NOT NULL,removed_at timestamptz);
CREATE TABLE IF NOT EXISTS public.generations(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES public.users(id));
CREATE TABLE IF NOT EXISTS public.generated_images(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),generation_id uuid REFERENCES public.generations(id),user_id uuid REFERENCES public.users(id),accepted boolean NOT NULL DEFAULT false,is_uploaded boolean NOT NULL DEFAULT false,storage_url text,deleted_at timestamptz);
