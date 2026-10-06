-- Prompt lineage (Kev, 2026-08-24: "ich will hier auch nachverfolgung,
-- damit ich weiß welcher prompt mithilfe welchem prompt erstellt wurde").
-- A prompt born from "put prompt to editor" records its parent; creator
-- payout splits can read this chain later without reconstructing history.
ALTER TABLE prompts
  ADD COLUMN IF NOT EXISTS derived_from_prompt_id uuid NULL REFERENCES prompts(id);
CREATE INDEX IF NOT EXISTS idx_prompts_derived_from
  ON prompts (derived_from_prompt_id) WHERE derived_from_prompt_id IS NOT NULL;
