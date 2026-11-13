import type pg from 'pg';
import type { AuthUser } from '../auth/authenticate.js';
import { requireProjectAccess } from '../auth/access.js';
import { pool, withTransaction } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import type { Page } from '../lib/pagination.js';
import { escapeLike } from '../lib/sql.js';
import { type ChainEntry, loadChains, lockTaskGraph } from './graph.js';

export type TaskStatus = 'not_started' | 'in_progress' | 'done';
export type TaskAction = 'start' | 'complete' | 'reopen';
export type TaskSort = 'id' | 'name' | 'startDate' | 'endDate' | 'dependents';

export interface Task {
  id: string;
  name: string;
  plannedStart: string;
  plannedEnd: string;
  status: TaskStatus;
  isLate: boolean;
  isBlocked: boolean;
  dependsOn: string[];
  dependentsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends Task {
  allowedActions: TaskAction[];
  waitsOn: ChainEntry[];
  waitedOnBy: ChainEntry[];
}

export interface TaskListQuery {
  status?: TaskStatus[];
  late?: boolean;
  blocked?: boolean;
  from?: string;
  to?: string;
  q?: string;
  sort: TaskSort;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

const SORT_COLUMNS: Record<TaskSort, string> = {
  id: 'task_no',
  name: 'lower(name)',
  startDate: 'planned_start',
  endDate: 'planned_end',
  dependents: 'dependents_count',
};

interface TaskFilter extends Partial<TaskListQuery> {
  code?: string;
}

// Late and Blocked are derived here on every read, so they always reflect today's date and current state.
// Blocked only needs open_prereq_count: a task can't start until its prerequisites are done, so if all
// direct prerequisites are done, every indirect one is too.
function taskQuery(sort: TaskSort, order: 'asc' | 'desc', withActions: boolean) {
  const dir = order === 'desc' ? 'DESC' : 'ASC';
  const orderBy = `${SORT_COLUMNS[sort]} ${dir}, task_no ${dir}`;
  const actions = withActions
    ? `, (status = 'not_started' AND open_prereq_count = 0) AS can_start,
         (status = 'in_progress') AS can_complete,
         (status = 'done' AND NOT EXISTS (
            SELECT 1 FROM task_dependencies d JOIN tasks c ON c.id = d.task_id
             WHERE d.depends_on_id = page.id AND c.status <> 'not_started')) AS can_reopen`
    : '';
  return `
WITH dependent_counts AS (
  SELECT depends_on_id AS task_id, count(*) AS n
    FROM task_dependencies
   WHERE project_id = $1
   GROUP BY depends_on_id
),
filtered AS (
  SELECT t.id, t.task_no, t.code, t.name, t.planned_start, t.planned_end, t.status,
         t.open_prereq_count, t.created_at, t.updated_at,
         COALESCE(dc.n, 0) AS dependents_count,
         (t.status <> 'done' AND (t.planned_end < CURRENT_DATE
            OR (t.status = 'not_started' AND t.planned_start < CURRENT_DATE))) AS is_late,
         (t.status <> 'done' AND t.open_prereq_count > 0) AS is_blocked
    FROM tasks t
    LEFT JOIN dependent_counts dc ON dc.task_id = t.id
   WHERE t.project_id = $1
     AND ($2::text IS NULL OR t.code = $2)
     AND ($3::text[] IS NULL OR t.status = ANY($3))
     AND ($4::date IS NULL OR t.planned_end >= $4)
     AND ($5::date IS NULL OR t.planned_start <= $5)
     AND ($6::text IS NULL OR t.name ILIKE '%' || $6 || '%' OR t.code ILIKE '%' || $6 || '%')
),
page AS (
  SELECT *, count(*) OVER () AS total
    FROM filtered
   WHERE ($7::boolean IS NULL OR is_late = $7)
     AND ($8::boolean IS NULL OR is_blocked = $8)
   ORDER BY ${orderBy}
   LIMIT $9 OFFSET $10
)
SELECT page.*,
       ARRAY(SELECT p.code FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_id
              WHERE d.task_id = page.id ORDER BY p.task_no) AS depends_on
       ${actions}
  FROM page
 ORDER BY ${orderBy}`;
}

interface TaskRow {
  id: number;
  code: string;
  name: string;
  planned_start: string;
  planned_end: string;
  status: TaskStatus;
  is_late: boolean;
  is_blocked: boolean;
  depends_on: string[];
  dependents_count: number;
  created_at: Date;
  updated_at: Date;
  total: number;
  can_start?: boolean;
  can_complete?: boolean;
  can_reopen?: boolean;
}

function toTask(r: TaskRow): Task {
  return {
    id: r.code,
    name: r.name,
    plannedStart: r.planned_start,
    plannedEnd: r.planned_end,
    status: r.status,
    isLate: r.is_late,
    isBlocked: r.is_blocked,
    dependsOn: r.depends_on,
    dependentsCount: r.dependents_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function runTaskQuery(
  db: pg.Pool | pg.PoolClient,
  projectId: number,
  f: TaskFilter,
  sort: TaskSort,
  order: 'asc' | 'desc',
  limit: number,
  offset: number,
  withActions = false,
) {
  const search = f.q?.trim() ? escapeLike(f.q.trim()) : null;
  return db.query<TaskRow>(taskQuery(sort, order, withActions), [
    projectId,
    f.code ?? null,
    f.status?.length ? f.status : null,
    f.from ?? null,
    f.to ?? null,
    search,
    f.late ?? null,
    f.blocked ?? null,
    limit,
    offset,
  ]);
}

export async function listTasks(user: AuthUser, projectCode: string, query: TaskListQuery): Promise<Page<Task>> {
  const { projectId } = await requireProjectAccess(user, projectCode);
  const { rows } = await runTaskQuery(
    pool, projectId, query, query.sort, query.order, query.pageSize, (query.page - 1) * query.pageSize,
  );
  return { items: rows.map(toTask), page: query.page, pageSize: query.pageSize, total: rows[0]?.total ?? 0 };
}

export async function loadTaskDetail(db: pg.Pool | pg.PoolClient, projectId: number, taskCode: string): Promise<TaskDetail> {
  const { rows } = await runTaskQuery(db, projectId, { code: taskCode }, 'id', 'asc', 1, 0, true);
  const r = rows[0];
  if (!r) throw notFound('Task not found');
  const allowedActions: TaskAction[] = [];
  if (r.can_start) allowedActions.push('start');
  if (r.can_complete) allowedActions.push('complete');
  if (r.can_reopen) allowedActions.push('reopen');
  const chains = await loadChains(db, projectId, r.id);
  return { ...toTask(r), allowedActions, ...chains };
}

export async function getTask(user: AuthUser, projectCode: string, taskCode: string): Promise<TaskDetail> {
  const { projectId } = await requireProjectAccess(user, projectCode);
  return loadTaskDetail(pool, projectId, taskCode);
}

export async function createTask(
  user: AuthUser,
  projectCode: string,
  input: { name: string; plannedStart: string; plannedEnd: string },
): Promise<TaskDetail> {
  return withTransaction(async (client) => {
    const { projectId } = await requireProjectAccess(user, projectCode, client);
    // Row lock on the project: concurrent creates in one project queue here and each gets the next number.
    // A rolled-back insert also rolls back the counter, so numbers are never skipped or reused.
    const { rows } = await client.query<{ taskNo: number; projectCode: string }>(
      `UPDATE projects SET next_task_no = next_task_no + 1
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING next_task_no AS "taskNo", code AS "projectCode"`,
      [projectId],
    );
    if (!rows[0]) throw notFound('Project not found');
    const { taskNo } = rows[0];
    const code = `${rows[0].projectCode}-T-${String(taskNo).padStart(4, '0')}`;
    await client.query(
      `INSERT INTO tasks (project_id, task_no, code, name, planned_start, planned_end)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [projectId, taskNo, code, input.name, input.plannedStart, input.plannedEnd],
    );
    return loadTaskDetail(client, projectId, code);
  });
}

export async function updateTask(
  user: AuthUser,
  projectCode: string,
  taskCode: string,
  input: { name?: string; plannedStart?: string; plannedEnd?: string },
): Promise<TaskDetail> {
  const { projectId } = await requireProjectAccess(user, projectCode);
  const { rowCount } = await pool.query(
    `UPDATE tasks
        SET name = COALESCE($3, name),
            planned_start = COALESCE($4, planned_start),
            planned_end = COALESCE($5, planned_end),
            updated_at = now()
      WHERE project_id = $1 AND code = $2`,
    [projectId, taskCode, input.name ?? null, input.plannedStart ?? null, input.plannedEnd ?? null],
  );
  if (!rowCount) throw notFound('Task not found');
  return loadTaskDetail(pool, projectId, taskCode);
}

interface LockedTask {
  id: number;
  status: TaskStatus;
  openPrereqs: number;
}

async function lockTask(client: pg.PoolClient, projectId: number, taskCode: string): Promise<LockedTask> {
  const { rows } = await client.query<LockedTask>(
    `SELECT id, status, open_prereq_count AS "openPrereqs"
       FROM tasks WHERE project_id = $1 AND code = $2 FOR UPDATE`,
    [projectId, taskCode],
  );
  if (!rows[0]) throw notFound('Task not found');
  return rows[0];
}

// When a task becomes done (delta -1) or stops being done (delta +1), its direct dependents gain or
// lose one unfinished prerequisite.
async function adjustDependents(client: pg.PoolClient, taskId: number, delta: 1 | -1): Promise<void> {
  await client.query(
    `UPDATE tasks SET open_prereq_count = open_prereq_count + $2
      WHERE id IN (SELECT task_id FROM task_dependencies WHERE depends_on_id = $1)`,
    [taskId, delta],
  );
}

async function setStatus(client: pg.PoolClient, taskId: number, status: TaskStatus): Promise<void> {
  await client.query('UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1', [taskId, status]);
}

export async function applyAction(
  user: AuthUser,
  projectCode: string,
  taskCode: string,
  action: TaskAction,
): Promise<TaskDetail> {
  return withTransaction(async (client) => {
    const { projectId } = await requireProjectAccess(user, projectCode, client);
    await lockTaskGraph(client, projectId);
    const task = await lockTask(client, projectId, taskCode);

    if (action === 'start') {
      if (task.status !== 'not_started') throw conflict('Only a Not started task can be started');
      if (task.openPrereqs > 0) {
        throw conflict(`Waiting on ${task.openPrereqs} unfinished task(s) it depends on`);
      }
      await setStatus(client, task.id, 'in_progress');
    } else if (action === 'complete') {
      if (task.status !== 'in_progress') throw conflict('Only an In progress task can be marked as done');
      await setStatus(client, task.id, 'done');
      await adjustDependents(client, task.id, -1);
    } else {
      if (task.status !== 'done') throw conflict('Only a Done task can be reopened');
      // Checking direct dependents is enough: an indirect dependent can only have started if a direct one is done.
      const { rowCount } = await client.query(
        `SELECT 1 FROM task_dependencies d JOIN tasks c ON c.id = d.task_id
          WHERE d.depends_on_id = $1 AND c.status <> 'not_started' LIMIT 1`,
        [task.id],
      );
      if (rowCount) throw conflict('A task that waits on this one has already started');
      await setStatus(client, task.id, 'in_progress');
      await adjustDependents(client, task.id, 1);
    }
    return loadTaskDetail(client, projectId, taskCode);
  });
}

// The task number is never reused: the project's counter only goes up.
export async function deleteTask(user: AuthUser, projectCode: string, taskCode: string): Promise<void> {
  await withTransaction(async (client) => {
    const { projectId } = await requireProjectAccess(user, projectCode, client);
    await lockTaskGraph(client, projectId);
    const task = await lockTask(client, projectId, taskCode);
    if (task.status !== 'done') await adjustDependents(client, task.id, -1);
    await client.query('DELETE FROM tasks WHERE id = $1', [task.id]);
  });
}
