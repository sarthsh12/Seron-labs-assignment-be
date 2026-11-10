import { config } from '../config.js';
import { pool } from '../db.js';
import { AppError, conflict, unauthorized } from '../lib/errors.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../lib/password.js';
import { hashToken, newRefreshToken, signAccessToken } from '../lib/tokens.js';
import type { AppRole } from './authenticate.js';

export interface PublicUser {
  id: number;
  name: string;
  email: string;
  role: AppRole;
  createdAt: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const USER_COLUMNS = `id, name, email, role, created_at AS "createdAt"`;

async function startSession(userId: number): Promise<TokenPair> {
  const refreshToken = newRefreshToken();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3)) RETURNING id`,
    [userId, hashToken(refreshToken), config.refreshTokenTtlDays],
  );
  const accessToken = await signAccessToken({ userId, sessionId: rows[0].id });
  return { accessToken, refreshToken, expiresIn: config.accessTokenTtlSeconds };
}

export async function register(input: { name: string; email: string; password: string; role: AppRole }) {
  const passwordHash = await hashPassword(input.password);
  try {
    const { rows } = await pool.query<PublicUser>(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
      [input.name, input.email, passwordHash, input.role],
    );
    return { user: rows[0], ...(await startSession(rows[0].id)) };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('An account with this email already exists');
    throw err;
  }
}

export async function login(email: string, password: string) {
  const { rows } = await pool.query<PublicUser & { passwordHash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash AS "passwordHash" FROM users WHERE email = $1`,
    [email],
  );
  const found = rows[0];
  // Always run the hash check so response time doesn't reveal whether the email exists.
  const ok = await verifyPassword(password, found?.passwordHash ?? DUMMY_HASH);
  if (!found || !ok) throw unauthorized('Invalid email or password');

  const { passwordHash: _, ...user } = found;
  return { user, ...(await startSession(user.id)) };
}

// Rotation: each refresh token works once and is replaced, and the session's expiry slides forward,
// so active users stay logged in while a stolen, already-used token is useless.
export async function refresh(refreshToken: string): Promise<TokenPair> {
  const next = newRefreshToken();
  const { rows } = await pool.query<{ id: string; userId: number }>(
    `UPDATE sessions
        SET refresh_token_hash = $2, expires_at = now() + make_interval(days => $3)
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, user_id AS "userId"`,
    [hashToken(refreshToken), hashToken(next), config.refreshTokenTtlDays],
  );
  if (rows.length === 0) throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired refresh token');
  const accessToken = await signAccessToken({ userId: rows[0].userId, sessionId: rows[0].id });
  return { accessToken, refreshToken: next, expiresIn: config.accessTokenTtlSeconds };
}

export async function logout(sessionId: string): Promise<void> {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function getProfile(userId: number): Promise<PublicUser> {
  const { rows } = await pool.query<PublicUser>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
  return rows[0];
}
