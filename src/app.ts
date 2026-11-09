import Fastify from 'fastify';
import { pool } from './db.js';

// Builds the Fastify app. Kept separate from server.ts so tests can create an app without listening on a port.
export function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  // Health check: confirms the API is up and can reach the database.
  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  return app;
}
