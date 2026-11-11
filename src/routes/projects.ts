import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationQuery } from '../lib/pagination.js';
import { parse } from '../lib/validation.js';
import * as projects from '../projects/service.js';

const projectFields = {
  name: z.string().trim().min(1).max(200),
  plannedStart: z.iso.date(),
  plannedEnd: z.iso.date(),
};

const endNotBeforeStart = (p: { plannedStart?: string; plannedEnd?: string }) =>
  !p.plannedStart || !p.plannedEnd || p.plannedEnd >= p.plannedStart;
const dateError = { message: 'plannedEnd must be on or after plannedStart', path: ['plannedEnd'] };

const createBody = z.object(projectFields).refine(endNotBeforeStart, dateError);
const updateBody = z.object(projectFields).partial().refine(endNotBeforeStart, dateError);

const listQuery = z.object({
  q: z.string().max(200).optional(),
  hasLateTasks: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['name', 'startDate', 'percentDone', 'lateTasks']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  ...paginationQuery,
});

const params = z.object({ projectId: z.string() });

export async function projectRoutes(app: FastifyInstance) {
  app.get('/projects', async (request) => projects.listProjects(request.user, parse(listQuery, request.query)));

  app.post('/projects', async (request, reply) => {
    const project = await projects.createProject(request.user, parse(createBody, request.body));
    reply.code(201);
    return project;
  });

  app.get('/projects/:projectId', async (request) => {
    const { projectId } = parse(params, request.params);
    return projects.getProject(request.user, projectId);
  });

  app.patch('/projects/:projectId', async (request) => {
    const { projectId } = parse(params, request.params);
    return projects.updateProject(request.user, projectId, parse(updateBody, request.body));
  });

  app.delete('/projects/:projectId', async (request, reply) => {
    const { projectId } = parse(params, request.params);
    await projects.deleteProject(request.user, projectId);
    reply.code(204);
  });
}
