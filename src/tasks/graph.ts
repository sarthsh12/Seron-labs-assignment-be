import type pg from 'pg';
import type { TaskStatus } from './service.js';

// Status changes, task deletion and dependency changes in one project take this lock, so they run one
// at a time. That keeps open_prereq_count correct and stops two concurrent edits from creating a cycle.
// It is separate from the project row lock, so task creation, member changes and deliveries never wait on it.
const TASK_GRAPH_LOCK = 1;
export async function lockTaskGraph(client: pg.PoolClient, projectId: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [TASK_GRAPH_LOCK, projectId]);
}

// True if `fromId` already waits on `toId`, directly or through other tasks.
// UNION (not UNION ALL) discards tasks already visited, so the walk ends even on large graphs.
export async function waitsOn(db: pg.Pool | pg.PoolClient, fromId: number, toId: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `WITH RECURSIVE upstream(id) AS (
       SELECT depends_on_id FROM task_dependencies WHERE task_id = $1
       UNION
       SELECT d.depends_on_id FROM task_dependencies d JOIN upstream u ON d.task_id = u.id
     )
     SELECT 1 FROM upstream WHERE id = $2 LIMIT 1`,
    [fromId, toId],
  );
  return rowCount === 1;
}

export interface ChainEntry {
  id: string;
  name: string;
  status: TaskStatus;
  steps: number;
}

// Breadth-first search from `start`: the first time a task is reached is its shortest distance.
function distances(start: number, next: Map<number, number[]>): Map<number, number> {
  const seen = new Map<number, number>();
  let frontier = [start];
  for (let step = 1; frontier.length > 0; step++) {
    const following: number[] = [];
    for (const id of frontier) {
      for (const n of next.get(id) ?? []) {
        if (n !== start && !seen.has(n)) {
          seen.set(n, step);
          following.push(n);
        }
      }
    }
    frontier = following;
  }
  return seen;
}

// Every task this one waits on and every task that waits on it, with how many steps away each is.
// A project has at most a few thousand tasks, so its edges are loaded once and walked in memory:
// a plain recursive query would revisit a task once per path, which explodes on diamond-shaped graphs.
export async function loadChains(db: pg.Pool | pg.PoolClient, projectId: number, taskId: number) {
  const { rows: edges } = await db.query<{ t: number; d: number }>(
    'SELECT task_id AS t, depends_on_id AS d FROM task_dependencies WHERE project_id = $1',
    [projectId],
  );
  const upstream = new Map<number, number[]>();
  const downstream = new Map<number, number[]>();
  for (const { t, d } of edges) {
    if (!upstream.has(t)) upstream.set(t, []);
    upstream.get(t)!.push(d);
    if (!downstream.has(d)) downstream.set(d, []);
    downstream.get(d)!.push(t);
  }
  const up = distances(taskId, upstream);
  const down = distances(taskId, downstream);

  const ids = [...new Set([...up.keys(), ...down.keys()])];
  const { rows: tasks } = ids.length
    ? await db.query<{ id: number; code: string; name: string; status: TaskStatus; taskNo: number }>(
        'SELECT id, code, name, status, task_no AS "taskNo" FROM tasks WHERE id = ANY($1)',
        [ids],
      )
    : { rows: [] };
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const toList = (found: Map<number, number>): ChainEntry[] =>
    [...found.entries()]
      .map(([id, steps]) => ({ task: byId.get(id)!, steps }))
      .sort((a, b) => a.steps - b.steps || a.task.taskNo - b.task.taskNo)
      .map(({ task, steps }) => ({ id: task.code, name: task.name, status: task.status, steps }));

  return { waitsOn: toList(up), waitedOnBy: toList(down) };
}
