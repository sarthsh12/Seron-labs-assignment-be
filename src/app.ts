import Fastify from 'fastify';
import { ZodError } from 'zod';
import { authenticate } from './auth/authenticate.js';
import { pool } from './db.js';
import { AppError } from './lib/errors.js';
import { protectedAuthRoutes, publicAuthRoutes } from './routes/auth.js';
import { memberRoutes } from './routes/members.js';
import { notificationRoutes } from './routes/notifications.js';
import { projectRoutes } from './routes/projects.js';
import { taskRoutes } from './routes/tasks.js';

export function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues },
      });
    }
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    // Database CHECK constraints (e.g. end date before start date) are the client's fault, not a server error.
    if ((err as { code?: string }).code === '23514') {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid values' } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    }
    request.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.register(publicAuthRoutes);

  // Everything registered inside this scope requires a valid, unrevoked session.
  app.register(async (secured) => {
    secured.addHook('onRequest', authenticate);
    secured.register(protectedAuthRoutes);
    secured.register(projectRoutes);
    secured.register(memberRoutes);
    secured.register(notificationRoutes);
    secured.register(taskRoutes);
  });

  return app;
}
