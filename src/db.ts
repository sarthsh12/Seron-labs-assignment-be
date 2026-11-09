import pg from 'pg';
import { config } from './config.js';

// One shared connection pool for the whole app.
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

// Runs `fn` inside a transaction: commits if it succeeds, rolls back if it throws.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
