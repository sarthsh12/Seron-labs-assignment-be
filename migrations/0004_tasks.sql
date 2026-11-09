CREATE TABLE tasks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id    bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_no       int    NOT NULL,
  code          text   NOT NULL, -- e.g. PRJ-0042-T-0137, written once at insert
  name          text   NOT NULL,
  planned_start date   NOT NULL,
  planned_end   date   NOT NULL,
  status        text   NOT NULL DEFAULT 'not_started'
                CHECK (status IN ('not_started', 'in_progress', 'done')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_end >= planned_start),
  UNIQUE (project_id, task_no),
  UNIQUE (project_id, id) -- target for the same-project foreign keys below
);
CREATE UNIQUE INDEX tasks_code_idx ON tasks (code);
CREATE INDEX tasks_project_status_idx ON tasks (project_id, status);
CREATE INDEX tasks_project_start_idx ON tasks (project_id, planned_start);
CREATE INDEX tasks_project_end_idx ON tasks (project_id, planned_end);
CREATE INDEX tasks_name_trgm_idx ON tasks USING gin (name gin_trgm_ops);

-- "task_id depends on depends_on_id". Repeating project_id in both foreign keys
-- lets the database itself reject a dependency between tasks of different projects.
CREATE TABLE task_dependencies (
  project_id    bigint NOT NULL,
  task_id       bigint NOT NULL,
  depends_on_id bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_id),
  FOREIGN KEY (project_id, task_id)       REFERENCES tasks (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, depends_on_id) REFERENCES tasks (project_id, id) ON DELETE CASCADE,
  CHECK (task_id <> depends_on_id)
);
CREATE INDEX task_dependencies_reverse_idx ON task_dependencies (depends_on_id, task_id);
CREATE INDEX task_dependencies_project_idx ON task_dependencies (project_id);
