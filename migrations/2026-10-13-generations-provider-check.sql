-- generations.provider: allow every provider the routing table can pick
-- (found on devnet 2026-10-13; applied live by hand the same night).
--
-- The live check accepted only 'gemini' and 'pollinations' and was not in the
-- repo's migrations. lib/generation/resolution.ts routes Nano Banana 2 at
-- 2K/4K to WaveSpeed and GPT-Image-2 to OpenAI, so every such paid image was
-- rendered and paid at the provider, then refused while being recorded. The
-- list is the code's Provider type (lib/generation/models.ts). Safe to run twice.
BEGIN;
ALTER TABLE public.generations
  DROP CONSTRAINT IF EXISTS generations_provider_check;
ALTER TABLE public.generations
  ADD CONSTRAINT generations_provider_check
  CHECK (provider IN ('gemini', 'openai', 'wavespeed', 'pollinations', 'acedata', 'none'));
COMMIT;
