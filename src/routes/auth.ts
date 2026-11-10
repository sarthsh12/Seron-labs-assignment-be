import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as auth from '../auth/service.js';
import { parse } from '../lib/validation.js';

const registerBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(320),
  password: z.string().min(8).max(200),
  role: z.enum(['user', 'store_manager', 'super_admin']),
});

const loginBody = z.object({
  email: z.string().max(320),
  password: z.string().max(200),
});

const refreshBody = z.object({ refreshToken: z.string().min(1) });

export async function publicAuthRoutes(app: FastifyInstance) {
  app.post('/auth/register', async (request, reply) => {
    const body = parse(registerBody, request.body);
    reply.code(201);
    return auth.register(body);
  });

  app.post('/auth/login', async (request) => {
    const { email, password } = parse(loginBody, request.body);
    return auth.login(email, password);
  });

  app.post('/auth/refresh', async (request) => {
    const { refreshToken } = parse(refreshBody, request.body);
    return auth.refresh(refreshToken);
  });
}

export async function protectedAuthRoutes(app: FastifyInstance) {
  app.post('/auth/logout', async (request, reply) => {
    await auth.logout(request.user.sessionId);
    reply.code(204);
  });

  app.get('/me', async (request) => auth.getProfile(request.user.id));
}
