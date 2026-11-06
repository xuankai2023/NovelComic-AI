ALTER TABLE productions ADD COLUMN IF NOT EXISTS shot_limit_fen bigint NOT NULL DEFAULT 0;
ALTER TABLE productions ADD COLUMN IF NOT EXISTS max_paid_calls_per_shot integer NOT NULL DEFAULT 0;
ALTER TABLE productions ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE productions ADD COLUMN IF NOT EXISTS request_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE productions ADD COLUMN IF NOT EXISTS stage_facts jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE productions ADD COLUMN IF NOT EXISTS can_produce_playable boolean NOT NULL DEFAULT false;
ALTER TABLE productions ADD COLUMN IF NOT EXISTS degraded boolean NOT NULL DEFAULT false;
ALTER TABLE productions ADD COLUMN IF NOT EXISTS last_error_code text;
ALTER TABLE productions ADD COLUMN IF NOT EXISTS last_error_message text;

ALTER TABLE productions DROP CONSTRAINT IF EXISTS productions_shot_limit_fen_check;
ALTER TABLE productions
  ADD CONSTRAINT productions_shot_limit_fen_check CHECK (shot_limit_fen >= 0);
ALTER TABLE productions DROP CONSTRAINT IF EXISTS productions_max_paid_calls_check;
ALTER TABLE productions
  ADD CONSTRAINT productions_max_paid_calls_check CHECK (max_paid_calls_per_shot >= 0);

CREATE TABLE IF NOT EXISTS draft_revisions (
  project_id text NOT NULL REFERENCES drafts(project_id),
  revision integer NOT NULL CHECK (revision >= 0),
  project_json jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  command_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, revision)
);

CREATE TABLE IF NOT EXISTS shot_budgets (
  production_id text NOT NULL REFERENCES productions(production_id),
  shot_id text NOT NULL,
  reserved_fen bigint NOT NULL DEFAULT 0 CHECK (reserved_fen >= 0),
  actual_fen bigint NOT NULL DEFAULT 0 CHECK (actual_fen >= 0),
  paid_calls integer NOT NULL DEFAULT 0 CHECK (paid_calls >= 0),
  PRIMARY KEY (production_id, shot_id)
);

ALTER TABLE cost_entries ADD COLUMN IF NOT EXISTS operation_key text;
ALTER TABLE cost_entries ADD COLUMN IF NOT EXISTS refunded_fen bigint NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS cost_entries_operation_key_unique
  ON cost_entries (production_id, operation_key)
  WHERE operation_key IS NOT NULL;

ALTER TABLE output_batch_renders ADD COLUMN IF NOT EXISTS bucket_name text;
ALTER TABLE output_batch_renders ADD COLUMN IF NOT EXISTS progress double precision NOT NULL DEFAULT 0;
ALTER TABLE output_batch_renders ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
ALTER TABLE output_batch_renders ADD COLUMN IF NOT EXISTS shot_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE output_batch_renders ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT true;
ALTER TABLE output_batch_renders ADD COLUMN IF NOT EXISTS object_key text;

ALTER TABLE asset_artifacts ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE asset_artifacts ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS asset_artifacts_tenant_reuse_idx
  ON asset_artifacts (tenant_id, stage, input_hash)
  WHERE status = 'completed';
