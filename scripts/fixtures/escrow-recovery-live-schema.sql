-- Fixture from the read-only live schema probe, 2026-10-05. No application data.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
-- Referenced IDs only; no other pricing or model fields are used by this test.
CREATE TABLE public.models (id uuid PRIMARY KEY);
CREATE TABLE public.pricing_rules (id uuid PRIMARY KEY);
CREATE TABLE public."artist_cost_ledger" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "artist_wallet" text NOT NULL,
  "mint" text NOT NULL,
  "entry" text NOT NULL,
  "micro" bigint NOT NULL,
  "lamports" bigint,
  "intent_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "artist_cost_ledger_entry_check" CHECK (entry = ANY (ARRAY['fronted'::text, 'recovered'::text])),
  CONSTRAINT "artist_cost_ledger_lamports_check" CHECK (lamports IS NULL OR lamports > 0),
  CONSTRAINT "artist_cost_ledger_lamports_on_fronting" CHECK ((entry = 'fronted'::text) = (lamports IS NOT NULL)),
  CONSTRAINT "artist_cost_ledger_micro_check" CHECK (micro > 0),
  CONSTRAINT "artist_cost_ledger_pkey" PRIMARY KEY (id),
  CONSTRAINT "artist_cost_ledger_recovery_has_intent" CHECK (entry <> 'recovered'::text OR intent_id IS NOT NULL)
);
CREATE INDEX artist_cost_ledger_account_idx ON public.artist_cost_ledger USING btree (artist_wallet, mint);
CREATE UNIQUE INDEX artist_cost_ledger_one_fronting ON public.artist_cost_ledger USING btree (artist_wallet, mint) WHERE (entry = 'fronted'::text);
CREATE UNIQUE INDEX artist_cost_ledger_one_recovery_per_intent ON public.artist_cost_ledger USING btree (intent_id, artist_wallet, mint) WHERE (entry = 'recovered'::text);
ALTER TABLE public."artist_cost_ledger" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."generation_payment_intents" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "buyer_wallet" text NOT NULL,
  "prompt_id" text,
  "model_family" text NOT NULL,
  "resolution" text NOT NULL DEFAULT '2K'::text,
  "artist_wallet" text,
  "artist_amount_micro" bigint NOT NULL,
  "model_cost_micro" bigint NOT NULL,
  "enki_fee_micro" bigint NOT NULL,
  "total_micro" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'USDC'::text,
  "fee_bps" integer NOT NULL,
  "fee_base" text NOT NULL,
  "fee_mode" text NOT NULL,
  "status" text NOT NULL DEFAULT 'quoted'::text,
  "tx_signature" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_valid_block_height" bigint,
  "consumed_at" timestamp with time zone,
  "fulfilled_at" timestamp with time zone,
  "fronted_atas" jsonb,
  "authorized_at" timestamp with time zone,
  "nonce_account" text,
  "nonce_authority" text,
  "authorized_tx_ct" text,
  "authorized_tx_iv" text,
  "authorized_tx_tag" text,
  "authorized_tx_kid" text,
  "heartbeat_at" timestamp with time zone,
  "captured_at" timestamp with time zone,
  "voided_at" timestamp with time zone,
  "void_reason" text,
  "applied_rule_id" uuid,
  "model_id" uuid,
  "quality" text,
  "boost" boolean NOT NULL DEFAULT false,
  "reference_image_count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "generation_payment_intents_applied_rule_id_fkey" FOREIGN KEY (applied_rule_id) REFERENCES pricing_rules(id),
  CONSTRAINT "generation_payment_intents_artist_amount_micro_check" CHECK (artist_amount_micro >= 0),
  CONSTRAINT "generation_payment_intents_enki_fee_micro_check" CHECK (enki_fee_micro >= 0),
  CONSTRAINT "generation_payment_intents_model_cost_micro_check" CHECK (model_cost_micro >= 0),
  CONSTRAINT "generation_payment_intents_model_id_fkey" FOREIGN KEY (model_id) REFERENCES models(id),
  CONSTRAINT "generation_payment_intents_pkey" PRIMARY KEY (id),
  CONSTRAINT "generation_payment_intents_quality_check" CHECK (quality IS NULL OR (quality = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))),
  CONSTRAINT "generation_payment_intents_reference_image_count_check" CHECK (reference_image_count >= 0 AND reference_image_count <= 18),
  CONSTRAINT "generation_payment_intents_single_outcome" CHECK (captured_at IS NULL OR voided_at IS NULL),
  CONSTRAINT "generation_payment_intents_status_check" CHECK (status = ANY (ARRAY['quoted'::text, 'building'::text, 'submitted'::text, 'confirmed'::text, 'failed'::text, 'expired'::text, 'authorized'::text, 'generating'::text, 'captured'::text, 'voided'::text])),
  CONSTRAINT "generation_payment_intents_total_micro_check" CHECK (total_micro >= 0),
  CONSTRAINT "generation_payment_intents_void_reason_check" CHECK (void_reason IS NULL OR (void_reason = ANY (ARRAY['provider_failed'::text, 'rejected'::text, 'cancelled'::text, 'abandoned'::text, 'expired'::text])))
);
CREATE INDEX generation_payment_intents_buyer_idx ON public.generation_payment_intents USING btree (buyer_wallet, created_at DESC);
CREATE INDEX generation_payment_intents_live_idx ON public.generation_payment_intents USING btree (heartbeat_at) WHERE ((authorized_at IS NOT NULL) AND (captured_at IS NULL) AND (voided_at IS NULL));
CREATE INDEX generation_payment_intents_status_idx ON public.generation_payment_intents USING btree (status, expires_at);
CREATE INDEX gpi_rule_buyer_day_idx ON public.generation_payment_intents USING btree (applied_rule_id, buyer_wallet, created_at) WHERE (applied_rule_id IS NOT NULL);
ALTER TABLE public."generation_payment_intents" ENABLE ROW LEVEL SECURITY;
