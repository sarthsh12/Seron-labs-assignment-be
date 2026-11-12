import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/validation.js';
import * as members from '../members/service.js';

const projectParams = z.object({ projectId: z.string() });
const memberParams = projectParams.extend({ userId: z.coerce.number().int().positive() });
const invitationParams = projectParams.extend({ invitationId: z.coerce.number().int().positive() });

const inviteBody = z.object({ email: z.string().trim().max(320) });
const updateMemberBody = z.object({ isAdmin: z.boolean() });

export async function memberRoutes(app: FastifyInstance) {
  app.get('/projects/:projectId/members', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    return members.listMembers(request.user, projectId);
  });

  app.post('/projects/:projectId/invitations', async (request, reply) => {
    const { projectId } = parse(projectParams, request.params);
    const { email } = parse(inviteBody, request.body);
    reply.code(201);
    return members.invite(request.user, projectId, email);
  });

  app.delete('/projects/:projectId/invitations/:invitationId', async (request, reply) => {
    const { projectId, invitationId } = parse(invitationParams, request.params);
    await members.withdrawInvitation(request.user, projectId, invitationId);
    reply.code(204);
  });

  app.patch('/projects/:projectId/members/:userId', async (request, reply) => {
    const { projectId, userId } = parse(memberParams, request.params);
    const { isAdmin } = parse(updateMemberBody, request.body);
    await members.setAdmin(request.user, projectId, userId, isAdmin);
    reply.code(204);
  });

  app.delete('/projects/:projectId/members/:userId', async (request, reply) => {
    const { projectId, userId } = parse(memberParams, request.params);
    await members.removeMember(request.user, projectId, userId);
    reply.code(204);
  });
}
