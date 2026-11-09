import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { runMigrations } from './migrate.js';

// Migrations run on startup, so `docker compose up` gives a ready-to-use API with no extra steps.
await runMigrations();

const app = buildApp();
await app.listen({ port: config.port, host: '0.0.0.0' });

// Shut down cleanly when Docker stops the container.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
