import type pg from 'pg';
import type { AuthUser } from '../auth/authenticate.js';
import { requireProjectAccess } from '../auth/access.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { lockTaskGraph, waitsOn } from './graph.js';
import { loadTaskDetail, type TaskDetail, type TaskStatus } from './service.js';

interface TaskRef {
  id: number;
  status: TaskStatus;
}

// Tasks are only looked up inside the project in the URL, so a task from another project is simply "not found".
async function findTask(client: pg.PoolClient, projectId: number, code: string): Promise<TaskRef | undefined> {
  const { rows } = await client.query<TaskRef>(
    'SELECT id, status FROM tasks WHERE project_id = $1 AND code = $2',
    [projectId, code],
  );
  return rows[0];
}

// "taskCode depends on dependsOnCode": taskCode can't start until dependsOnCode is done.
export async function addDependency(
  user: AuthUser,
  projectCode: string,
  taskCode: string,
  dependsOnCode: string,
): Promise<TaskDetail> {
  return withTransaction(async (client) => {
    const { projectId } = await requireProjectAccess(user, projectCode, client);
    await lockTaskGraph(client, projectId);

    const task = await findTask(client, projectId, taskCode);
    if (!task) throw notFound('Task not found');
    const prereq = await findTask(client, projectId, dependsOnCode);
    if (!prereq) throw badRequest('dependsOn must be a task in the same project');
    if (task.id === prereq.id) throw badRequest('A task cannot depend on itself');

    // Adding "task waits on prereq" closes a loop if prereq already waits on task.
    if (await waitsOn(client, prereq.id, task.id)) {
      throw conflict(`${dependsOnCode} already waits on ${taskCode}; this would create a cycle`);
    }
    // Keeps the rule "a task only starts once everything it waits on is done" true afterwards too.
    if (task.status !== 'not_started' && prereq.status !== 'done') {
      throw conflict(`${taskCode} has already started, so it can only depend on tasks that are done`);
    }

    const { rowCount } = await client.query(
      `INSERT INTO task_dependencies (project_id, task_id, depends_on_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [projectId, task.id, prereq.id],
    );
    if (!rowCount) throw conflict(`${taskCode} already depends on ${dependsOnCode}`);
    if (prereq.status !== 'done') {
      await client.query('UPDATE tasks SET open_prereq_count = open_prereq_count + 1 WHERE id = $1', [task.id]);
    }
    return loadTaskDetail(client, projectId, taskCode);
  });
}

export async function removeDependency(
  user: AuthUser,
  projectCode: string,
  taskCode: string,
  dependsOnCode: string,
): Promise<TaskDetail> {
  return withTransaction(async (client) => {
    const { projectId } = await requireProjectAccess(user, projectCode, client);
    await lockTaskGraph(client, projectId);

    const task = await findTask(client, projectId, taskCode);
    if (!task) throw notFound('Task not found');
    const prereq = await findTask(client, projectId, dependsOnCode);
    const { rowCount } = prereq
      ? await client.query('DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_id = $2', [
          task.id,
          prereq.id,
        ])
      : { rowCount: 0 };
    if (!prereq || !rowCount) throw notFound('Dependency not found');

    if (prereq.status !== 'done') {
      await client.query('UPDATE tasks SET open_prereq_count = open_prereq_count - 1 WHERE id = $1', [task.id]);
    }
    return loadTaskDetail(client, projectId, taskCode);
  });
}
