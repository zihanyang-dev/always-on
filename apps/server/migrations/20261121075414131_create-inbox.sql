-- Up Migration
CREATE TYPE always_on.inbox_source AS ENUM ('user', 'channel');

CREATE TABLE always_on.inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES always_on.workspaces(id),
  source_kind always_on.inbox_source NOT NULL,
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
  source_event_id text NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  conversation_id text,
  reply_to text,
  occurred_at timestamptz(3),
  received_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  trace_parent text,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  completed_at timestamptz,
  UNIQUE (workspace_id, source_kind, source_id, source_event_id),
  CHECK (completed_at IS NULL OR lease_token IS NULL)
);

CREATE INDEX inbox_events_available_idx
  ON always_on.inbox_events (available_at, id) WHERE completed_at IS NULL;
