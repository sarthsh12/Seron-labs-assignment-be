import type { AuthUser } from '../auth/authenticate.js';
import { requireProjectAccess, requireProjectAdmin } from '../auth/access.js';
import { pool, withTransaction } from '../db.js';
import { conflict } from '../lib/errors.js';
import type { Page } from '../lib/pagination.js';

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

// Builds every project row the user may see, with its task and member stats, in one round trip.
// Late and blocked are worked out from today's date and open_prereq_count, never stored.
function summarySql(sort: ProjectSort, order: 'asc' | 'desc') {
  const dir = order === 'desc' ? 'DESC' : 'ASC';
  return `
WITH visible AS (
  SELECT p.id, p.code, p.name, p.planned_start, p.planned_end, p.created_at,
         COALESCE(pm.is_admin, false) AS is_admin
    FROM projects p
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
   WHERE p.deleted_at IS NULL
     AND ($2::boolean OR pm.user_id IS NOT NULL)
     AND ($3::bigint IS NULL OR p.id = $3)
     AND ($4::text IS NULL OR p.name ILIKE '%' || $4 || '%' OR p.code ILIKE $4 || '%')
),
task_stats AS (
  SELECT t.project_id,
         count(*) AS total,
         count(*) FILTER (WHERE t.status = 'not_started') AS not_started,
         count(*) FILTER (WHERE t.status = 'in_progress') AS in_progress,
         count(*) FILTER (WHERE t.status = 'done') AS done,
         count(*) FILTER (WHERE t.status <> 'done' AND (t.planned_end < CURRENT_DATE
                            OR (t.status = 'not_started' AND t.planned_start < CURRENT_DATE))) AS late,
         count(*) FILTER (WHERE t.status <> 'done' AND t.open_prereq_count > 0) AS blocked
    FROM tasks t
    JOIN visible v ON v.id = t.project_id
   GROUP BY t.project_id
),
member_stats AS (
  SELECT pm.project_id, count(*) AS members
    FROM project_members pm
    JOIN visible v ON v.id = pm.project_id
   GROUP BY pm.project_id
),
summary AS (
  SELECT v.*,
         COALESCE(ms.members, 0) AS members,
         COALESCE(ts.total, 0) AS total,
         COALESCE(ts.not_started, 0) AS not_started,
         COALESCE(ts.in_progress, 0) AS in_progress,
         COALESCE(ts.done, 0) AS done,
         COALESCE(ts.late, 0) AS late,
         COALESCE(ts.blocked, 0) AS blocked,
         CASE WHEN COALESCE(ts.total, 0) = 0 THEN 0
              ELSE round(100.0 * ts.done / ts.total, 1)::float8 END AS percent_done
    FROM visible v
    LEFT JOIN task_stats ts ON ts.project_id = v.id
    LEFT JOIN member_stats ms ON ms.project_id = v.id
)
SELECT *, count(*) OVER () AS total_count
  FROM summary
 WHERE ($5::boolean IS NOT TRUE OR late > 0)
 ORDER BY ${SORT_COLUMNS[sort]} ${dir}, id ${dir}
 LIMIT $6 OFFSET $7`;
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

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export async function listProjects(user: AuthUser, query: ProjectListQuery): Promise<Page<ProjectSummary>> {
  const search = query.q?.trim() ? escapeLike(query.q.trim()) : null;
  const { rows } = await pool.query<SummaryRow>(summarySql(query.sort, query.order), [
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
  const { rows } = await pool.query<SummaryRow>(summarySql('name', 'asc'), [
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
      `UPDATE invitations SET status = 'withdrawn', responded_at = now() WHERE project_id = $1 AND status = 'pending'`,
      [access.projectId],
    );
  });
}
