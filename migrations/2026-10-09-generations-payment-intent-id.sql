-- REC-1: link a generation back to the payment intent that bought it.
--
-- `generations` already carries transaction_hash, chain_key and
-- amount_paid_cents (added in 6c63aa8, 2026-08-06 — no migration file for
-- those three ever landed in this folder, but the live table has 9 rows
-- written through that exact insert since that date, which it could not
-- have if the columns did not exist; flagged in docs/specs/REC-1.md as a
-- documentation gap, not re-derived here). payment_intent_id is new and
-- does not exist anywhere yet (confirmed: zero grep hits across the repo
-- before this change).
--
-- Not yet applied automatically — run in the Supabase SQL editor, like
-- every other file in this folder (see generation_payment_intents.sql's
-- own header). Additive and re-runnable.

ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS payment_intent_id uuid REFERENCES generation_payment_intents(id);

COMMENT ON COLUMN generations.payment_intent_id IS
  'The generation_payment_intents row this generation was bought with. Null '
  'for free generations and for anything generated before this column '
  'existed. Lets a buyer''s payment be traced forward to the image it paid '
  'for, and a refund/dispute traced back to the generation it produced.';

CREATE INDEX IF NOT EXISTS generations_payment_intent_idx
  ON generations (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

-- Check:
--   SELECT id, payment_intent_id, transaction_hash, chain_key, amount_paid_cents
--   FROM generations ORDER BY created_at DESC LIMIT 10;
