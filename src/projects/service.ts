import type { AuthUser } from '../auth/authenticate.js';
import { requireProjectAccess, requireProjectAdmin } from '../auth/access.js';
import { pool, withTransaction } from '../db.js';
import { conflict } from '../lib/errors.js';
import type { Page } from '../lib/pagination.js';
import { escapeLike } from '../lib/sql.js';

export type ProjectSort = 'name' | 'startDate' | 'percentDone' | 'lateTasks';

export interface ProjectListQuery {
  q?: string;
  hasLateTasks?: boolean;
  sort: ProjectSort;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  plannedStart: string;
  plannedEnd: string;
  isAdmin: boolean;
  memberCount: number;
  taskCounts: { total: number; notStarted: number; inProgress: number; done: number };
  percentDone: number;
  lateTasks: number;
  blockedTasks: number;
  createdAt: string;
}

// Whitelisted, so user input never reaches ORDER BY directly.
const SORT_COLUMNS: Record<ProjectSort, string> = {
  name: 'lower(name)',
  startDate: 'planned_start',
  percentDone: 'percent_done',
  lateTasks: 'late',
};

// Late = not started with a past start date, or in progress with a past end date (a not-started task
// past its end date is also past its start). Each half is a range read on its own partial index.
const LATE_COUNT = (projectId: string) => `
  (SELECT count(*) FROM tasks WHERE project_id = ${projectId} AND status = 'not_started' AND planned_start < CURRENT_DATE)
  + (SELECT count(*) FROM tasks WHERE project_id = ${projectId} AND status = 'in_progress' AND planned_end < CURRENT_DATE)`;

// Three stages: rank the visible projects using only cheap numbers (stored totals, and late counts from
// small indexes when sorting or filtering by them), take one page, then compute the full stats for
// just that page. A SuperAdmin sees 2,000 projects, but only 20 get the full treatment.
function summarySql(sort: ProjectSort, order: 'asc' | 'desc', needLate: boolean) {
  const dir = order === 'desc' ? 'DESC' : 'ASC';
  return `
WITH visible AS (
  SELECT p.id, p.code, p.name, p.planned_start, p.planned_end, p.created_at,
         COALESCE(pm.is_admin, false) AS is_admin,
         CASE WHEN s.task_count = 0 THEN 0
              ELSE round(100.0 * s.done_count / s.task_count, 1)::float8 END AS percent_done
         ${needLate ? `, ${LATE_COUNT('p.id')} AS late` : ''}
    FROM projects p
    JOIN project_task_stats s ON s.project_id = p.id
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
   WHERE p.deleted_at IS NULL
     AND ($2::boolean OR pm.user_id IS NOT NULL)
     AND ($3::bigint IS NULL OR p.id = $3)
     AND ($4::text IS NULL OR p.name ILIKE '%' || $4 || '%' OR p.code ILIKE $4 || '%')
),
page AS (
  SELECT *, count(*) OVER () AS total_count
    FROM visible
   WHERE ${needLate ? '($5::boolean IS NOT TRUE OR late > 0)' : '$5::boolean IS NOT TRUE'}
   ORDER BY ${SORT_COLUMNS[sort]} ${dir}, id ${dir}
   LIMIT $6 OFFSET $7
)
SELECT page.id, page.code, page.name, page.planned_start, page.planned_end, page.created_at, page.is_admin,
       page.percent_done, page.total_count, ts.*, ms.members
  FROM page
  CROSS JOIN LATERAL (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE t.status = 'not_started') AS not_started,
           count(*) FILTER (WHERE t.status = 'in_progress') AS in_progress,
           count(*) FILTER (WHERE t.status = 'done') AS done,
           count(*) FILTER (WHERE t.status <> 'done' AND t.open_prereq_count > 0) AS blocked,
           ${LATE_COUNT('page.id')} AS late
      FROM tasks t WHERE t.project_id = page.id) ts
  CROSS JOIN LATERAL (SELECT count(*) AS members FROM project_members WHERE project_id = page.id) ms
 ORDER BY ${SORT_COLUMNS[sort]} ${dir}, id ${dir}`;
}

interface SummaryRow {
  id: number;
  code: string;
  name: string;
  planned_start: string;
  planned_end: string;
  created_at: Date;
  is_admin: boolean;
  members: number;
  total: number;
  not_started: number;
  in_progress: number;
  done: number;
  late: number;
  blocked: number;
  percent_done: number;
  total_count: number;
}

function toSummary(r: SummaryRow): ProjectSummary {
  return {
    id: r.code,
    name: r.name,
    plannedStart: r.planned_start,
    plannedEnd: r.planned_end,
    isAdmin: r.is_admin,
    memberCount: r.members,
    taskCounts: { total: r.total, notStarted: r.not_started, inProgress: r.in_progress, done: r.done },
    percentDone: r.percent_done,
    lateTasks: r.late,
    blockedTasks: r.blocked,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listProjects(user: AuthUser, query: ProjectListQuery): Promise<Page<ProjectSummary>> {
  const search = query.q?.trim() ? escapeLike(query.q.trim()) : null;
  const needLate = query.sort === 'lateTasks' || query.hasLateTasks === true;
  const { rows } = await pool.query<SummaryRow>(summarySql(query.sort, query.order, needLate), [
    user.id,
    user.role === 'super_admin',
    null,
    search,
    query.hasLateTasks ?? null,
    query.pageSize,
    (query.page - 1) * query.pageSize,
  ]);
  return {
    items: rows.map(toSummary),
    page: query.page,
    pageSize: query.pageSize,
    total: rows[0]?.total_count ?? 0,
  };
}

export async function getProject(user: AuthUser, code: string): Promise<ProjectSummary> {
  const access = await requireProjectAccess(user, code);
  const { rows } = await pool.query<SummaryRow>(summarySql('name', 'asc', false), [
    user.id, true, access.projectId, null, null, 1, 0,
  ]);
  return toSummary(rows[0]);
}

export async function createProject(
  user: AuthUser,
  input: { name: string; plannedStart: string; plannedEnd: string },
): Promise<ProjectSummary> {
  const code = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: number; code: string }>(
      `INSERT INTO projects (name, planned_start, planned_end, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id, code`,
      [input.name, input.plannedStart, input.plannedEnd, user.id],
    );
    const { id, code } = rows[0];
    await client.query(`INSERT INTO stores (kind, project_id) VALUES ('project', $1)`, [id]);
    await client.query('INSERT INTO project_task_stats (project_id) VALUES ($1)', [id]);
    await client.query(`INSERT INTO project_members (project_id, user_id, is_admin) VALUES ($1, $2, true)`, [id, user.id]);
    return code;
  });
  return getProject(user, code);
}

export async function updateProject(
  user: AuthUser,
  code: string,
  input: { name?: string; plannedStart?: string; plannedEnd?: string },
): Promise<ProjectSummary> {
  const access = await requireProjectAdmin(user, code);
  await pool.query(
    `UPDATE projects
        SET name = COALESCE($2, name),
            planned_start = COALESCE($3, planned_start),
            planned_end = COALESCE($4, planned_end),
            updated_at = now()
      WHERE id = $1`,
    [access.projectId, input.name ?? null, input.plannedStart ?? null, input.plannedEnd ?? null],
  );
  return getProject(user, code);
}

// Soft delete: the row stays so past deliveries keep their project, and the code is never reused.
export async function deleteProject(user: AuthUser, code: string): Promise<void> {
  await withTransaction(async (client) => {
    const access = await requireProjectAdmin(user, code, client);
    await client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [access.projectId]);
    const { rowCount } = await client.query(
      `SELECT 1 FROM deliveries WHERE project_id = $1 AND status = 'in_transit' LIMIT 1`,
      [access.projectId],
    );
    if (rowCount) throw conflict('Project has deliveries in transit; resolve them before removing it');
    await client.query('UPDATE projects SET deleted_at = now(), updated_at = now() WHERE id = $1', [access.projectId]);
    await client.query(
      `UPDATE invitations SET status = 'withdrawn', responded_at = now(), read_at = COALESCE(read_at, now())
        WHERE project_id = $1 AND status = 'pending'`,
      [access.projectId],
    );
  });
}
