import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationQuery } from '../lib/pagination.js';
import { parse } from '../lib/validation.js';
import * as notifications from '../notifications/service.js';

const listQuery = z.object(paginationQuery);
const idParams = z.object({ id: z.coerce.number().int().positive() });

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/notifications', async (request) => {
    const { page, pageSize } = parse(listQuery, request.query);
    return notifications.listNotifications(request.user, page, pageSize);
  });

  app.get('/notifications/unread-count', async (request) => ({
    unreadCount: await notifications.unreadCount(request.user),
  }));

  app.post('/notifications/read', async (request) => ({
    unreadCount: await notifications.markRead(request.user),
  }));

  app.post('/notifications/:id/read', async (request) => {
    const { id } = parse(idParams, request.params);
    return { unreadCount: await notifications.markRead(request.user, id) };
  });

  app.post('/invitations/:id/accept', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await notifications.respond(request.user, id, true);
    reply.code(204);
  });

  app.post('/invitations/:id/reject', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await notifications.respond(request.user, id, false);
    reply.code(204);
  });
}
