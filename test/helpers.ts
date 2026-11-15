import { after } from 'node:test';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

// Tests run against a real Postgres, in a separate database so seeded data is never touched.
// Each test file starts from empty tables; files run one at a time (see "test" in package.json).
const dbName = new URL(config.databaseUrl).pathname.slice(1);
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run tests against "${dbName}": name must end in _test`);

export const app = buildApp();

async function createDatabaseIfMissing() {
  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
}

async function resetDatabase() {
  const { rows } = await pool.query<{ tables: string }>(
    `SELECT string_agg(quote_ident(tablename), ', ') AS tables
       FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  await pool.query(`TRUNCATE ${rows[0].tables} RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO stores (kind) VALUES ('company')`);
}

// Top-level await: this finishes before any test file that imports helpers starts running,
// so every file's own setup sees empty tables.
await createDatabaseIfMissing();
await runMigrations();
await resetDatabase();

after(async () => {
  await app.close();
  await pool.end();
});

export interface Response<T = any> {
  status: number;
  body: T;
}

// Sends a request to the app in memory (no network), optionally as a logged-in user.
export async function call<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Response<T>> {
  const res = await app.inject({
    method,
    url,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

export interface TestUser {
  id: number;
  email: string;
  token: string;
  refreshToken: string;
}

let userCount = 0;
export async function registerUser(role: 'user' | 'store_manager' | 'super_admin' = 'user'): Promise<TestUser> {
  const email = `person${++userCount}@test.com`;
  const res = await call('POST', '/auth/register', {
    body: { name: `Person ${userCount}`, email, password: 'secret123', role },
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, email, token: res.body.accessToken, refreshToken: res.body.refreshToken };
}

export async function createProject(owner: TestUser, name = 'Test Project'): Promise<string> {
  const res = await call('POST', '/projects', {
    token: owner.token,
    body: { name, plannedStart: '2026-01-01', plannedEnd: '2027-12-31' },
  });
  if (res.status !== 201) throw new Error(`create project failed: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

// Invites and accepts in one go, so the user ends up a plain (non-admin) member.
export async function addMember(admin: TestUser, projectId: string, member: TestUser): Promise<void> {
  const invite = await call('POST', `/projects/${projectId}/invitations`, { token: admin.token, body: { email: member.email } });
  const accept = await call('POST', `/invitations/${invite.body.id}/accept`, { token: member.token });
  if (accept.status !== 204) throw new Error(`accept failed: ${JSON.stringify(accept.body)}`);
}

export async function createTask(
  user: TestUser,
  projectId: string,
  name: string,
  dates: { plannedStart: string; plannedEnd: string } = { plannedStart: '2027-03-01', plannedEnd: '2027-03-10' },
): Promise<string> {
  const res = await call('POST', `/projects/${projectId}/tasks`, { token: user.token, body: { name, ...dates } });
  if (res.status !== 201) throw new Error(`create task failed: ${JSON.stringify(res.body)}`);
  return res.body.id;
}
