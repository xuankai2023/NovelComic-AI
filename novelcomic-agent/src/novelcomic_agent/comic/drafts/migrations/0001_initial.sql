BEGIN;

CREATE TABLE productions (
  production_id text PRIMARY KEY,
  project_id text NOT NULL UNIQUE,
  tenant_id text NOT NULL,
  state text NOT NULL CHECK (state IN (
    'CREATED', 'INGESTING', 'ANALYZING', 'SYNTHESIZING_VOICE',
    'PREPARING_ASSETS', 'COMPOSING', 'VALIDATING', 'PREVIEWING',
    'REVIEWING', 'FIXING', 'PLANNING_BATCHES', 'RENDERING_BATCHES',
    'PACKAGING', 'DELIVERED', 'PERMANENT_FAILED', 'CANCELLED'
  )),
  phase text NOT NULL CHECK (phase IN ('B', 'E')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  fixing_count integer NOT NULL DEFAULT 0 CHECK (fixing_count BETWEEN 0 AND 1),
  cancel_requested_at timestamptz,
  budget_limit_fen bigint NOT NULL CHECK (budget_limit_fen >= 0),
  reserved_cost_fen bigint NOT NULL DEFAULT 0 CHECK (reserved_cost_fen >= 0),
  actual_cost_fen bigint NOT NULL DEFAULT 0 CHECK (actual_cost_fen >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX productions_tenant_created_idx
  ON productions (tenant_id, created_at DESC);

CREATE TABLE idempotency_keys (
  tenant_id text NOT NULL,
  request_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  production_id text NOT NULL REFERENCES productions(production_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id)
);

CREATE TABLE drafts (
  project_id text PRIMARY KEY,
  revision integer NOT NULL CHECK (revision >= 0),
  project_json jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compose_commands (
  command_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES drafts(project_id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  name text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  expected_revision integer NOT NULL CHECK (expected_revision >= 0),
  resulting_revision integer CHECK (resulting_revision > expected_revision),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'committed', 'failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, ordinal),
  UNIQUE (command_id)
);

CREATE TABLE asset_artifacts (
  artifact_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES drafts(project_id),
  shot_id text,
  stage text NOT NULL CHECK (stage IN (
    'ingest', 'analyze', 'tts', 'clean-panel', 'l0-panel', 'layer-l1', 'layer-l2',
    'inpaint', 'preview', 'render-batch', 'package'
  )),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL,
  provider_request_id text,
  status text NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  checksums jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_fen bigint NOT NULL DEFAULT 0 CHECK (cost_fen >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX asset_artifacts_reuse_key
  ON asset_artifacts (project_id, stage, input_hash, COALESCE(shot_id, ''));

CREATE INDEX asset_artifacts_provider_request_idx
  ON asset_artifacts (provider_request_id)
  WHERE provider_request_id IS NOT NULL;

CREATE TABLE cost_entries (
  cost_entry_id text PRIMARY KEY,
  production_id text NOT NULL REFERENCES productions(production_id),
  shot_id text,
  provider text NOT NULL,
  provider_request_id text,
  reservation_fen bigint NOT NULL CHECK (reservation_fen >= 0),
  actual_fen bigint CHECK (actual_fen >= 0),
  status text NOT NULL CHECK (
    status IN ('reserved', 'settled', 'released', 'reconciliation_required')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cost_entries_provider_request_unique
  ON cost_entries (provider_request_id)
  WHERE provider_request_id IS NOT NULL;

CREATE TABLE output_batch_renders (
  output_batch_render_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES drafts(project_id),
  batch_id text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  render_id text,
  status text NOT NULL CHECK (
    status IN ('pending', 'submitted', 'rendering', 'completed', 'failed', 'cancelled')
  ),
  url text,
  checksum text,
  frame_from integer NOT NULL CHECK (frame_from >= 0),
  frame_to integer NOT NULL CHECK (frame_to > frame_from),
  render_config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, batch_id, content_hash)
);

CREATE TABLE outbox_events (
  event_id text PRIMARY KEY,
  aggregate_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_events_dispatch_idx
  ON outbox_events (available_at, created_at)
  WHERE published_at IS NULL;

CREATE TABLE worker_jobs (
  job_key text PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_key)
);

CREATE INDEX worker_jobs_claim_idx
  ON worker_jobs (type, status, lease_expires_at, created_at);

COMMIT;
