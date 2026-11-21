-- Up Migration
CREATE TYPE always_on.work_event_disposition AS ENUM ('assigned', 'needs_routing', 'rejected');

CREATE TABLE always_on.work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES always_on.workspaces(id),
  created_by text NOT NULL REFERENCES always_on.users(id),
  goal text NOT NULL,
  progress text,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE always_on.work_thread_bindings (
  workspace_id uuid NOT NULL,
  work_id uuid NOT NULL,
  -- Bound the UTF-8 width of both text columns in the composite B-tree key.
  connection_id text NOT NULL CHECK (octet_length(connection_id) BETWEEN 1 AND 200),
  conversation_id text NOT NULL CHECK (octet_length(conversation_id) BETWEEN 1 AND 2400),
  PRIMARY KEY (workspace_id, connection_id, conversation_id),
  FOREIGN KEY (workspace_id, work_id) REFERENCES always_on.work_items(workspace_id, id)
);

CREATE TABLE always_on.work_event_decisions (
  event_id uuid PRIMARY KEY REFERENCES always_on.inbox_events(id),
  disposition always_on.work_event_disposition NOT NULL,
  work_id uuid REFERENCES always_on.work_items(id),
  decided_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK ((disposition = 'assigned') = (work_id IS NOT NULL))
);

CREATE TABLE always_on.work_run_requests (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE REFERENCES always_on.work_event_decisions(event_id),
  work_id uuid NOT NULL REFERENCES always_on.work_items(id),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  completed_at timestamptz,
  CHECK (completed_at IS NULL OR lease_token IS NULL)
);

CREATE INDEX work_run_requests_pending_by_work_idx
  ON always_on.work_run_requests (work_id, sequence) WHERE completed_at IS NULL;
CREATE INDEX work_run_requests_available_idx
  ON always_on.work_run_requests (available_at, sequence) WHERE completed_at IS NULL;
