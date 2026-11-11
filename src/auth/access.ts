import type pg from 'pg';
import { pool } from '../db.js';
import { forbidden, notFound } from '../lib/errors.js';
import type { AuthUser } from './authenticate.js';

export interface ProjectAccess {
  projectId: number;
  code: string;
  isMember: boolean;
  isAdmin: boolean;
}

const PROJECT_CODE = /^PRJ-(\d{4,})$/;

export function projectIdFromCode(code: string): number | null {
  const match = PROJECT_CODE.exec(code);
  return match ? Number(match[1]) : null;
}

// Non-members get the same 404 as a project that doesn't exist, so a guessed ID reveals nothing.
export async function requireProjectAccess(
  user: AuthUser,
  code: string,
  db: pg.Pool | pg.PoolClient = pool,
): Promise<ProjectAccess> {
  const projectId = projectIdFromCode(code);
  if (projectId === null) throw notFound('Project not found');

  const { rows } = await db.query<{ code: string; isAdmin: boolean | null }>(
    `SELECT p.code, pm.is_admin AS "isAdmin"
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
      WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [projectId, user.id],
  );
  const row = rows[0];
  const isMember = row?.isAdmin != null;
  if (!row || (!isMember && user.role !== 'super_admin')) throw notFound('Project not found');

  return { projectId, code: row.code, isMember, isAdmin: row.isAdmin === true };
}

// Members who aren't admins already know the project exists, so they get 403 rather than 404.
export async function requireProjectAdmin(
  user: AuthUser,
  code: string,
  db: pg.Pool | pg.PoolClient = pool,
): Promise<ProjectAccess> {
  const access = await requireProjectAccess(user, code, db);
  if (!access.isAdmin) throw forbidden('Only project admins can do this');
  return access;
}
