import type { FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';

export type AppRole = 'user' | 'store_manager' | 'super_admin';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: AppRole;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

// The user and session are loaded from the database on every request rather than trusted from the token,
// so logout and role changes take effect immediately.
export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();

  const claims = await verifyAccessToken(header.slice(7));
  if (!claims) throw unauthorized('Invalid or expired token');

  const { rows } = await pool.query<AuthUser>(
    `SELECT u.id, u.name, u.email, u.role, s.id AS "sessionId"
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [claims.sessionId, claims.userId],
  );
  if (rows.length === 0) throw unauthorized('Session has ended');
  request.user = rows[0];
}
