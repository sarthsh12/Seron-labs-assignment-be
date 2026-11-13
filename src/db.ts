import pg from 'pg';
import { config } from './config.js';

// bigint ids fit safely in a JS number at this scale; plain dates stay "YYYY-MM-DD" strings to avoid time zone shifts.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

// Deadlock and serialization failures: Postgres cancelled the transaction, so it is safe to run it again.
const RETRYABLE = new Set(['40P01', '40001']);
const MAX_ATTEMPTS = 3;

// Runs `fn` inside a transaction: commits if it succeeds, rolls back if it throws.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      if (attempt < MAX_ATTEMPTS && RETRYABLE.has((err as { code?: string }).code ?? '')) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
