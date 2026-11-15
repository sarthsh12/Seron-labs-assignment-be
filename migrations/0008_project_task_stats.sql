-- Per-project task totals, kept up to date in the same transactions that create, complete, reopen and
-- delete tasks. Lets the projects list sort by percent done without counting 500k tasks per request.
-- A separate table keeps these frequent updates off the project row, which membership changes lock.
CREATE TABLE project_task_stats (
  project_id bigint PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  task_count int NOT NULL DEFAULT 0 CHECK (task_count >= 0),
  done_count int NOT NULL DEFAULT 0 CHECK (done_count >= 0 AND done_count <= task_count)
);

INSERT INTO project_task_stats (project_id, task_count, done_count)
SELECT p.id, count(t.id), count(t.id) FILTER (WHERE t.status = 'done')
  FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
 GROUP BY p.id;

-- Late = not started with a start date in the past, or in progress with an end date in the past.
-- These partial indexes hold only tasks that can be late, so counting late tasks reads just those.
CREATE INDEX tasks_late_not_started_idx ON tasks (project_id, planned_start) WHERE status = 'not_started';
CREATE INDEX tasks_late_in_progress_idx ON tasks (project_id, planned_end) WHERE status = 'in_progress';
