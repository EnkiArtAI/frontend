-- Private prompt / workflow library (Kev, 2026-09-05: "ne prompt / workflow
-- datenbank die ich mir in meinem profil privat speichere, sodass ich fix
-- auf die sachen zugreifen kann"). One row per saved item; `graph` is the
-- editor's own export format (enki-prompt-graph), so a saved workflow opens
-- in the node editor exactly as it was left, and can be embedded into
-- another prompt as a workflow node. Read/written only through
-- /api/library with the owner's session — never shown to anyone else.
CREATE TABLE IF NOT EXISTS saved_workflows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'workflow' CHECK (kind IN ('workflow', 'prompt')),
  graph        jsonb,
  prompt_text  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_workflows_user ON saved_workflows (user_id, updated_at DESC);
