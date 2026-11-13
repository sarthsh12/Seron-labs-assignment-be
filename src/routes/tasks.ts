import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationQuery } from '../lib/pagination.js';
import { parse } from '../lib/validation.js';
import * as tasks from '../tasks/service.js';

const STATUSES = ['not_started', 'in_progress', 'done'] as const;
const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

const taskFields = {
  name: z.string().trim().min(1).max(300),
  plannedStart: z.iso.date(),
  plannedEnd: z.iso.date(),
};
const endNotBeforeStart = (t: { plannedStart?: string; plannedEnd?: string }) =>
  !t.plannedStart || !t.plannedEnd || t.plannedEnd >= t.plannedStart;
const dateError = { message: 'plannedEnd must be on or after plannedStart', path: ['plannedEnd'] };

const createBody = z.object(taskFields).refine(endNotBeforeStart, dateError);
const updateBody = z.object(taskFields).partial().refine(endNotBeforeStart, dateError);

const listQuery = z.object({
  // ?status=not_started,in_progress
  status: z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()))
    .pipe(z.array(z.enum(STATUSES)))
    .optional(),
  late: booleanString.optional(),
  blocked: booleanString.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(['id', 'name', 'startDate', 'endDate', 'dependents']).default('id'),
  order: z.enum(['asc', 'desc']).default('asc'),
  ...paginationQuery,
});

const projectParams = z.object({ projectId: z.string() });
const taskParams = projectParams.extend({ taskId: z.string() });
const actionParams = taskParams.extend({ action: z.enum(['start', 'complete', 'reopen']) });

export async function taskRoutes(app: FastifyInstance) {
  app.get('/projects/:projectId/tasks', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    return tasks.listTasks(request.user, projectId, parse(listQuery, request.query));
  });

  app.post('/projects/:projectId/tasks', async (request, reply) => {
    const { projectId } = parse(projectParams, request.params);
    const task = await tasks.createTask(request.user, projectId, parse(createBody, request.body));
    reply.code(201);
    return task;
  });

  app.get('/projects/:projectId/tasks/:taskId', async (request) => {
    const { projectId, taskId } = parse(taskParams, request.params);
    return tasks.getTask(request.user, projectId, taskId);
  });

  app.patch('/projects/:projectId/tasks/:taskId', async (request) => {
    const { projectId, taskId } = parse(taskParams, request.params);
    return tasks.updateTask(request.user, projectId, taskId, parse(updateBody, request.body));
  });

  app.delete('/projects/:projectId/tasks/:taskId', async (request, reply) => {
    const { projectId, taskId } = parse(taskParams, request.params);
    await tasks.deleteTask(request.user, projectId, taskId);
    reply.code(204);
  });

  // POST /projects/PRJ-0001/tasks/PRJ-0001-T-0003/start | complete | reopen
  app.post('/projects/:projectId/tasks/:taskId/:action', async (request) => {
    const { projectId, taskId, action } = parse(actionParams, request.params);
    return tasks.applyAction(request.user, projectId, taskId, action);
  });
}
