CREATE TABLE deliveries (
  delivery_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  production_id text NOT NULL REFERENCES productions (production_id),
  project_id text NOT NULL,
  package_input_hash text NOT NULL CHECK (package_input_hash ~ '^[a-f0-9]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL,
  checksum text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  status text NOT NULL,
  url_generation integer NOT NULL,
  manifest_json jsonb NOT NULL,
  play_order jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT deliveries_production_hash_key UNIQUE (production_id, package_input_hash)
);

CREATE TABLE object_tombstones (
  tombstone_id text NOT NULL,
  tenant_id text NOT NULL,
  object_key text NOT NULL,
  category text NOT NULL,
  status text NOT NULL,
  reason text NOT NULL,
  retain_until timestamptz,
  requested_at timestamptz NOT NULL,
  deleted_at timestamptz,
  result text,
  CONSTRAINT tombstones_pkey PRIMARY KEY (tombstone_id),
  CONSTRAINT tombstones_tenant_object_key UNIQUE (tenant_id, object_key)
);

CREATE TABLE alerts (
  dedup_key text PRIMARY KEY,
  tenant_id text NOT NULL,
  production_id text,
  stage text NOT NULL,
  error_code text NOT NULL,
  window_start timestamptz NOT NULL,
  status text NOT NULL,
  summary text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Acceptance inserts the idempotency row before the production row in one transaction.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint AS con
  JOIN pg_class AS rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'idempotency_keys' AND con.contype = 'f'
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE idempotency_keys ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',
      constraint_name
    );
  END IF;
END $$;
