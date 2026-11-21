-- Up Migration
CREATE TYPE always_on.workspace_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE always_on.invitation_role AS ENUM ('member', 'viewer');
CREATE TYPE always_on.invitation_status AS ENUM ('pending', 'accepted', 'rejected', 'cancelled');

CREATE TABLE always_on.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE INDEX workspaces_created_idx ON always_on.workspaces (created_at, id);

CREATE TABLE always_on.workspace_members (
  workspace_id uuid NOT NULL REFERENCES always_on.workspaces(id),
  user_id text NOT NULL REFERENCES always_on.users(id),
  role always_on.workspace_role NOT NULL,
  joined_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user_idx ON always_on.workspace_members (user_id);
CREATE INDEX workspace_members_joined_idx
  ON always_on.workspace_members (workspace_id, joined_at, user_id);
CREATE INDEX workspace_members_owners_idx
  ON always_on.workspace_members (workspace_id) WHERE role = 'owner';

CREATE TABLE always_on.workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES always_on.workspaces(id),
  email text NOT NULL CHECK (email = lower(email)),
  role always_on.invitation_role NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status always_on.invitation_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  created_by text NOT NULL REFERENCES always_on.users(id)
);

CREATE UNIQUE INDEX workspace_invitations_pending_email_idx
  ON always_on.workspace_invitations (workspace_id, email) WHERE status = 'pending';
CREATE INDEX workspace_invitations_pending_created_idx
  ON always_on.workspace_invitations (workspace_id, created_at, id) WHERE status = 'pending';
