-- The identity sequence never hands out a number twice, even under concurrent inserts or after deletes.
CREATE TABLE projects (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          text GENERATED ALWAYS AS ('PRJ-' || lpad(id::text, greatest(4, length(id::text)), '0')) STORED UNIQUE,
  name          text NOT NULL,
  planned_start date NOT NULL,
  planned_end   date NOT NULL,
  next_task_no  int  NOT NULL DEFAULT 0, -- per-project task counter, bumped with UPDATE ... RETURNING
  created_by    bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz, -- soft delete keeps delivery and stock history intact
  CHECK (planned_end >= planned_start)
);
CREATE INDEX projects_name_trgm_idx ON projects USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX projects_start_idx ON projects (planned_start) WHERE deleted_at IS NULL;

CREATE TABLE project_members (
  project_id bigint  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    bigint  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin   boolean NOT NULL DEFAULT false,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
-- "Which projects is this user in?" is asked on almost every request.
CREATE INDEX project_members_user_idx ON project_members (user_id, project_id);

-- Invitations double as the notifications feed; read_at drives the unread count.
CREATE TABLE invitations (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id   bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  invitee_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by   bigint NOT NULL REFERENCES users(id),
  status       text   NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  read_at      timestamptz
);
CREATE UNIQUE INDEX invitations_one_pending_idx ON invitations (project_id, invitee_id) WHERE status = 'pending';
CREATE INDEX invitations_invitee_idx ON invitations (invitee_id, created_at DESC);
CREATE INDEX invitations_unread_idx ON invitations (invitee_id) WHERE read_at IS NULL;
CREATE INDEX invitations_project_pending_idx ON invitations (project_id) WHERE status = 'pending';
